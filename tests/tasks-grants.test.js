// The grant flow (spec docs/superpowers/specs/2026-11-03-tasks-stage1-design.md §4.6): a real
// LeaseManager with a fake relay and phone, a TaskManager over the tasks harness, one fake clock.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { open } = require('../src/approvals/envelope');
const { validateMessage } = require('../src/approvals/messages');
const { plainLineProblem } = require('../src/cases/hidden-chars');
const { LeaseManager } = require('../src/gui/leases');
const { GuiError } = require('../src/gui/errors');
const { parseGuiConfig } = require('../src/gui/config');
const { TaskGrants, taskName, raisedUsd } = require('../src/tasks/grants');
const { setLogLevel } = require('../src/logging');
const { createFakePhone, testNodeIdentity } = require('./helpers/fake-phone');
const { approverStoreWith } = require('./helpers/approver-set');
const { tasksHarness, fakeClock } = require('./helpers/tasks-harness');

setLogLevel('fatal');

const FRONT = { kind: 'frontdoor', client_id: 'c1', client_name: 'Example client', grant_id: 'g1', scopes: ['fleet:delegate', 'fleet:unsafe'], mcp_session: null };
const FIVE_MINUTES = 5 * 60000;
const PROPOSAL = { sites: ['a.example.com'], allows: ['browser-act', 'shell'], minutes: 20, usd: 2 };
const answer = (proposal) => async () => JSON.stringify(proposal);
const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const BASH = ['Bash', { command: 'x' }, {}];
const code = (name) => (err) => {
  assert.equal(err.code, name, err.message);
  return true;
};
const untilAborted = async (turn) => {
  await turn.aborted();
  return { type: 'stopped', content: '(Session stopped by user)' };
};
const reply = (content) => async () => ({ type: 'complete', content });

class FakeRelay extends EventEmitter {
  constructor() { super(); this.sent = []; this.connected = true; }
  isConnected() { return this.connected; }
  async pushNotify() { return { ok: true }; }
  async send(envelope, opts = {}) { this.sent.push({ envelope, opts, message: open(envelope).message }); return { ok: true }; }
  registerMethod() {}
  requests() { return this.sent.filter((s) => s.message.type === 'kl.lease.request'); }
  lastRequest() { return this.requests().at(-1); }
  down() { this.connected = false; this.emit('disconnected'); }
  up() { this.connected = true; this.emit('connected'); }
}

const guiConfig = parseGuiConfig({
  enabled: true,
  apps: { chrome: { name: 'Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', processes: ['chrome.exe'] } },
}, { platform: 'win32' });

let env;
beforeEach(async () => {
  const phone = createFakePhone({ name: 'Owner phone' });
  const other = createFakePhone({ name: 'Second phone' });
  const identity = testNodeIdentity({ key: 'gpu-box' });
  const time = fakeClock(Date.now());
  const approvers = await approverStoreWith([phone.approverRecord(), other.approverRecord()], { now: time.clock });
  const relay = new FakeRelay();
  const timers = { setTimeout: (fn, ms) => time.timers.set(fn, ms), clearTimeout: (t) => time.timers.clear(t) };
  const approval = { on: true };
  const leases = new LeaseManager({
    approvals: { identity, approverStore: approvers, relayClient: relay, phoneApprover: { isAvailable: () => approval.on } },
    guiConfig, nodeName: 'gpu-box', clock: time.clock, timers, jobOpen: () => true,
  });
  leases.start();
  const grants = new TaskGrants({ leases, clock: time.clock });
  env = {
    phone, other, identity, time, approvers, relay, leases, grants, approval, h: null,
    harness(options = {}) {
      this.h = tasksHarness({ clock: time, grants, ...options });
      return this.h;
    },
    press({ minutes = 20, decision = 'grant' } = {}) {
      const signedAt = new Date(time.clock()).toISOString();
      return leases.onGrant(phone.leaseGrant(relay.lastRequest().envelope, { decision, minutes, apps: [], signedAt }));
    },
    leaseId: () => relay.lastRequest().message.lease_id,
    card: () => relay.lastRequest().message.lease,
  };
});
afterEach(async () => {
  if (env.h) {
    await env.h.manager.stop();
    env.h.cleanup();
  }
  env.leases.stop();
  env.approvers.cleanup();
});

// A task whose first turn runs until it is cut, with the card out.
async function underWay(options = {}) {
  const t = env.harness({ callUtility: answer(PROPOSAL), script: [untilAborted], ...options });
  const view = await t.manager.run({ text: 'Find a dentist', origin: FRONT });
  const turn = await t.started();
  return { t, id: view.task_id, turn, policy: turn.options.executorOptions.taskPolicy };
}

// Settled or not, without waiting for it.
async function pendingAfterTicks(promise) {
  let done = false;
  promise.then(() => { done = true; });
  await tick();
  await tick();
  return !done;
}

// Controller rulings 2026-11-03. Nothing but run and send starts a turn, and a press does not, but
// a card pressed after the owner took the chat must not leave a live lease on a task nothing can run.
describe('a chat the owner has taken', () => {
  const MARKS = {
    became_case: (t, chatId) => t.history.updateChat(chatId, { caseId: 'case-1' }),
    private: (t, chatId) => t.history.getHistoryStore().markPrivate(chatId),
  };
  async function stuck() {
    const t = env.harness({ callUtility: answer(PROPOSAL), script: [reply('STUCK: I need a date')] });
    const view = await t.manager.run({ text: 'Find a dentist', origin: FRONT });
    await t.settled(t.manager, view.task_id);
    assert.equal(t.store.get(view.task_id).state, 'waiting');
    return { t, view };
  }

  for (const [reason, mark] of Object.entries(MARKS)) {
    it(`${reason}: a card pressed after it ends the task and the lease, and starts no turn`, async () => {
      const { t, view } = await stuck();
      mark(t, view.chat_id);
      env.press();
      await tick();
      const rec = t.store.get(view.task_id);
      assert.deepEqual([rec.state, rec.ended.reason], ['cancelled', reason]);
      assert.equal(env.leases.find(env.leaseId()).state, 'ended');
      assert.equal(t.calls.length, 1);
      assert.equal(t.manager.handles.size, 0);
    });

    it(`${reason}: a send ends a live lease with the task`, async () => {
      const { t, view } = await stuck();
      env.press();
      await tick();
      assert.equal(env.leases.find(env.leaseId()).state, 'active');
      mark(t, view.chat_id);
      await assert.rejects(t.manager.send(view.task_id, 'the fourth'), code('task_ended'));
      assert.equal(env.leases.find(env.leaseId()).state, 'ended');
      assert.equal(t.store.get(view.task_id).ended.reason, reason);
      assert.equal(t.calls.length, 1);
    });
  }
});

describe('a press whose chat will not read', () => {
  it('ends nothing: the grant lands, and the next send reads the chat again', async () => {
    const t = env.harness({ callUtility: answer(PROPOSAL), script: [reply('STUCK: I need a date'), reply('thanks')] });
    const view = await t.manager.run({ text: 'Find a dentist', origin: FRONT });
    await t.settled(t.manager, view.task_id);
    const { getChat } = t.core.context;
    t.core.context.getChat = () => { throw new Error('database is locked'); };
    env.press();
    await tick();
    t.core.context.getChat = getChat;
    const rec = t.store.get(view.task_id);
    assert.deepEqual([rec.state, rec.ended], ['waiting', null]);
    assert.ok(rec.grant, 'the press is recorded');
    assert.equal(env.leases.find(env.leaseId()).state, 'active');
    assert.equal(t.pushes.length, 0);
    await t.manager.send(view.task_id, 'Next Tuesday', { origin: FRONT });
    await t.settled(t.manager, view.task_id);
    assert.equal(t.store.get(view.task_id).state, 'done');
  });
});

describe('a task left waiting past the bound', () => {
  it('a lease that has lapsed is no reason to wait: 24 hours on it ends abandoned, and the lease is gone', async () => {
    const t = env.harness({ callUtility: answer(PROPOSAL), script: [reply('STUCK: I need a date'), reply('other')] });
    const view = await t.manager.run({ text: 'Find a dentist', origin: FRONT });
    await t.settled(t.manager, view.task_id);
    env.press();
    await tick();
    const lease = env.leaseId();
    assert.equal(env.leases.find(lease).state, 'active');
    t.time.advance(24 * 60 * 60 * 1000 + 1000);
    await tick();
    const next = await t.manager.run({ text: 'Another', origin: FRONT });
    await t.settled(t.manager, next.task_id);
    const rec = t.store.get(view.task_id);
    assert.deepEqual([rec.state, rec.ended.reason], ['cancelled', 'abandoned']);
    assert.equal(env.leases.find(lease).state, 'ended');
    assert.equal(t.pushes.filter((p) => p.id === view.task_id).length, 1);
  });
});

describe('the first card', () => {
  it('press allows: awaiting_grant, then the acting call runs with no phone prompt, and the record holds the grant', async () => {
    const { t, id, policy } = await underWay();
    let rec = t.store.get(id);
    assert.equal(rec.state, 'awaiting_grant');
    assert.equal(rec.card_sends, 1);
    assert.equal(rec.grant, null);
    const card = env.card();
    assert.deepEqual([card.kind, card.name, card.sites, card.allows, card.usd, card.max_minutes, card.unattended, card.reason],
      ['task', 'Find a dentist', ['a.example.com'], ['browser-act', 'shell'], 2, 20, true, 'Task from Example client']);
    assert.equal(card.job_id, `chat:${rec.chat_id}`);
    assert.equal(env.relay.lastRequest().message.origin.job_id, `chat:${rec.chat_id}`);

    const decided = policy.decide(...BASH);
    assert.equal(await pendingAfterTicks(decided), true, 'the acting call waits for the press');
    assert.equal(env.press().state, 'active');
    assert.deepEqual(await decided, { allow: true });

    rec = t.store.get(id);
    assert.equal(rec.state, 'running');
    const lease = env.leases.find(env.leaseId());
    assert.deepEqual(rec.grant, {
      lease_id: env.leaseId(),
      granted_at: new Date(t.time.clock()).toISOString(),
      by_device: env.phone.deviceId,
      expires_at: new Date(lease.expiresAt).toISOString(),
    });
    assert.equal(rec.deadline_at, rec.grant.expires_at, 'the press starts the card\'s minutes, and the turn runs to the same moment');
  });

  it('an acting browser call on a granted page runs with no prompt, off the sites it asks', async () => {
    let url = 'https://a.example.com/x';
    const t = env.harness({ callUtility: answer(PROPOSAL), script: [untilAborted] });
    await t.manager.stop();
    t.manager = t.build({ currentUrl: async () => url });
    await t.manager.run({ text: 'go', origin: FRONT });
    const turn = await t.started();
    env.press();
    const click = () => turn.options.executorOptions.taskPolicy.decide('BrowserPage', { action: 'click', selector: 'a' }, {});
    assert.deepEqual(await click(), { allow: true });
    url = 'https://other.example.org/';
    assert.equal((await click()).passthrough, true);
  });

  it('look-only needs no card', async () => {
    const t = env.harness({ callUtility: answer({ sites: [], allows: [], minutes: 20, usd: 2 }), script: [reply('read it')] });
    const view = await t.manager.run({ text: 'go', origin: FRONT });
    const rec = await t.settled(t.manager, view.task_id);
    assert.equal(env.relay.requests().length, 0);
    assert.equal(rec.grant, null);
    assert.equal(rec.proposal.lookOnly, true);
    assert.equal(rec.card_sends, 0);
    assert.equal(rec.state, 'done');
  });

  it('bad proposal: no request, and every acting call reaches the phone path', async () => {
    const { t, id, policy } = await underWay({ callUtility: async () => 'not json' });
    assert.equal(env.relay.requests().length, 0);
    const rec = t.store.get(id);
    assert.equal(rec.proposal, null);
    assert.equal(rec.state, 'running');
    assert.equal((await policy.decide(...BASH)).passthrough, true);
  });

  it('no lease manager: every acting call goes down the phone path, and the task says grant: null', async () => {
    const { t, id, policy } = await underWay({ grants: null });
    assert.equal(env.relay.requests().length, 0);
    assert.equal((await policy.decide(...BASH)).passthrough, true);
    const view = await t.manager.get(id);
    assert.equal(view.grant, null);
    assert.equal(view.state, 'running');
  });

  it('name from hostile text: the request is valid; nothing left is Task', async () => {
    const hostile = `Find\na\u202Edentist\u200B${'x'.repeat(8000)}`;
    assert.equal(hostile.length > 8000, true);
    const text = hostile.slice(0, 8000);
    const name = taskName(text);
    assert.equal(plainLineProblem(name), null);
    assert.ok([...name].length <= 60);
    assert.ok(name.startsWith('Find a dentist'));
    assert.equal(taskName('\u202E\u200B'), 'Task');

    for (const [input, want] of [[text, name], ['\u202E\u200B', 'Task']]) {
      const h = env.harness({ callUtility: answer(PROPOSAL), script: [untilAborted] });
      const view = await h.manager.run({ text: input, origin: { ...FRONT, client_name: 'Evil\n\u202Eclient' } });
      await h.started();
      const { message } = env.relay.lastRequest();
      assert.equal(validateMessage('kl.lease.request', message), null);
      assert.equal(message.lease.name, want);
      assert.equal(plainLineProblem(message.lease.reason), null);
      await h.manager.cancel(view.task_id);
      await h.settled(h.manager, view.task_id);
      await h.manager.stop();
      h.cleanup();
    }
    env.h = null;
  });

  it('the phone approver is away: per-call asks, grant: null, the task runs, and no card is out', async () => {
    env.approval.on = false;
    const { t, id, policy } = await underWay();
    await tick();
    assert.equal(env.relay.requests().length, 0);
    const rec = t.store.get(id);
    assert.equal(rec.state, 'running');
    assert.equal(rec.grant, null);
    assert.equal((await policy.decide(...BASH)).passthrough, true);
  });

  it('a request refused capability_unavailable: the same', async () => {
    env.leases.identityProbe = () => 'the record moved';
    const { t, id, policy } = await underWay();
    await tick();
    assert.equal(env.relay.requests().length, 0);
    assert.equal(t.store.get(id).state, 'running');
    assert.equal((await policy.decide(...BASH)).passthrough, true);
  });

  it('a call waiting when the request is refused is released, and asks', async () => {
    const real = env.leases.request;
    let refuse;
    env.leases.request = () => new Promise((resolve, reject) => { refuse = reject; });
    const { t, id, policy } = await underWay();
    const decided = policy.decide(...BASH);
    await tick();
    assert.equal(t.store.get(id).state, 'awaiting_grant');
    refuse(new GuiError('capability_unavailable', 'gui'));
    assert.equal((await decided).passthrough, true);
    assert.equal(t.store.get(id).state, 'running');
    env.leases.request = real;
  });
});

describe('a deny, a Stop and the end of a task', () => {
  it('deny ends: cancelled, grant_denied, and a waiting decide gets task_ended', async () => {
    const { t, id, turn, policy } = await underWay();
    const decided = policy.decide(...BASH);
    await tick();
    env.press({ decision: 'deny' });
    assert.equal((await decided).code, 'task_ended');
    assert.equal(turn.options.abortSignal.aborted, true);
    const rec = await t.settled(t.manager, id);
    assert.equal(rec.state, 'cancelled');
    assert.equal(rec.ended.reason, 'grant_denied');
    assert.deepEqual(t.pushes, [{ kind: 'task_ended', id }]);
  });

  it('Stop ends the task: the turn is aborted, cancelled, stopped, with the push; the next call is task_ended', async () => {
    const { t, id, turn, policy } = await underWay();
    env.press();
    assert.deepEqual(await policy.decide(...BASH), { allow: true });
    const signedAt = new Date(t.time.clock()).toISOString();
    env.leases.onRevoke(env.other.leaseRevoke(env.identity.nodeId, env.leaseId(), { signedAt }));
    assert.equal(turn.options.abortSignal.aborted, true);
    assert.equal((await policy.decide(...BASH)).code, 'task_ended');
    const rec = await t.settled(t.manager, id);
    assert.equal(rec.state, 'cancelled');
    assert.equal(rec.ended.reason, 'stopped');
    assert.deepEqual(t.pushes, [{ kind: 'task_ended', id }]);
    assert.equal(env.leases.current(), null);
  });

  it('Stop on a card nobody has answered ends it too', async () => {
    const { t, id, policy } = await underWay();
    const decided = policy.decide(...BASH);
    await tick();
    const signedAt = new Date(t.time.clock()).toISOString();
    env.leases.onRevoke(env.phone.leaseRevoke(env.identity.nodeId, env.leaseId(), { signedAt }));
    assert.equal((await decided).code, 'task_ended');
    assert.equal(t.store.get(id).ended.reason, 'stopped');
    assert.equal(env.relay.requests().length, 1, 'no card after a Stop');
  });

  it('device_revoked does the same', async () => {
    const { t, id, policy } = await underWay();
    env.press();
    env.approvers.isActive = () => false;
    env.leases.checkGrantingDevices();
    assert.equal(env.leases.find(env.leaseId()).endReason, 'device_revoked');
    assert.equal((await policy.decide(...BASH)).code, 'task_ended');
    const rec = await t.settled(t.manager, id);
    assert.equal(rec.state, 'cancelled');
    assert.equal(rec.ended.reason, 'stopped');
    assert.equal(t.pushes.length, 1);
  });

  const ENDINGS = [
    ['done', (t, id, resolve) => resolve({ type: 'complete', content: 'all done' })],
    ['cancelled', (t, id) => t.manager.cancel(id)],
    ['interrupted', (t) => t.manager.stop()],
  ];
  for (const [state, finish] of ENDINGS) {
    it(`lease ends at task end: ${state}, with no loop back into the task`, async () => {
      let resolve;
      const step = (turn) => new Promise((r) => {
        resolve = r;
        turn.aborted().then(() => r({ type: 'stopped', content: '' }));
      });
      const { t, id } = await underWay({ script: [step] });
      env.press();
      const leaseId = env.leaseId();
      await finish(t, id, resolve);
      const rec = await t.settled(t.manager, id);
      assert.equal(rec.state, state);
      assert.equal(env.leases.find(leaseId).state, 'ended');
      assert.equal(env.leases.find(leaseId).endReason, state);
      assert.equal(rec.ended ? rec.ended.reason : 'interrupted', state);
      assert.equal(t.pushes.length, 1, 'one task_ended, not two');
    });
  }

  it('an ending with the card still out takes it back, and sends no other', async () => {
    const { t, id } = await underWay();
    const before = env.relay.requests().length;
    await t.manager.cancel(id);
    assert.equal(env.leases.current(), null);
    t.time.advance(FIVE_MINUTES);
    assert.equal(env.relay.requests().length, before);
  });

  it('a task that waits for its client keeps its lease; shutdown lets it go', async () => {
    const { t, id } = await underWay({ script: [reply('STUCK: a wall')] });
    await t.settled(t.manager, id);
    assert.equal(t.store.get(id).state, 'waiting');
    env.press();
    assert.equal(env.leases.current().state, 'active');
    await t.manager.stop();
    assert.equal(env.leases.current(), null);
    assert.equal(t.store.get(id).state, 'waiting');
    assert.equal(t.manager.handles.size, 0);
  });
});

describe('an unanswered card', () => {
  it('expiry re-sends: a new lease id each 5 minutes, past the turn\'s cut at its minutes; after 12, waiting, grant_pending', async () => {
    const { t, id, turn } = await underWay();
    const seen = new Set([env.leaseId()]);
    for (let n = 2; n <= 12; n += 1) {
      t.time.advance(FIVE_MINUTES);
      assert.equal(env.relay.requests().length, n);
      seen.add(env.leaseId());
      assert.equal(t.store.get(id).card_sends, n);
      if (n === 4) {
        assert.equal(t.store.get(id).state, 'awaiting_grant');
        assert.equal(turn.options.abortSignal.aborted, false);
      }
      if (n === 5) {
        assert.equal(turn.options.abortSignal.aborted, true, 'twenty minutes: the turn stops with the card out');
        await t.settled(t.manager, id);
        assert.deepEqual([t.store.get(id).state, t.store.get(id).reason], ['waiting', 'duration']);
      }
    }
    assert.equal(seen.size, 12);
    t.time.advance(FIVE_MINUTES);
    assert.equal(env.relay.requests().length, 12);
    const rec = t.store.get(id);
    assert.equal(rec.state, 'waiting');
    assert.equal(rec.reason, 'grant_pending');
    assert.equal(t.pushes.length, 0);
  });

  it('a press on the live card resumes: the waiting call runs, and the turn gets the card\'s minutes from the press', async () => {
    const { t, id, turn, policy } = await underWay();
    const decided = policy.decide(...BASH);
    t.time.advance(FIVE_MINUTES);
    t.time.advance(FIVE_MINUTES);
    assert.equal(await pendingAfterTicks(decided), true);
    env.press();
    assert.deepEqual(await decided, { allow: true });
    assert.equal(t.store.get(id).state, 'running');
    t.time.advance(20 * 60000 - 1);
    assert.equal(turn.options.abortSignal.aborted, false);
    t.time.advance(1);
    assert.equal(turn.options.abortSignal.aborted, true);
    const rec = await t.settled(t.manager, id);
    assert.equal(rec.state, 'waiting');
    assert.equal(rec.reason, 'duration');
    assert.equal(env.leases.current(), null, 'the lease came down at the same moment');
  });

  it('send on grant_pending sends one more card, and is refused until its press; only the one', async () => {
    const { t, id } = await underWay({ script: [untilAborted, untilAborted] });
    for (let n = 0; n < 4; n += 1) t.time.advance(FIVE_MINUTES);
    await t.settled(t.manager, id);
    for (let n = 0; n < 8; n += 1) t.time.advance(FIVE_MINUTES);
    assert.equal(t.store.get(id).reason, 'grant_pending');
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), /a press on the phone is awaited/);
    assert.equal(env.relay.requests().length, 13);
    assert.equal(t.store.get(id).card_sends, 13);
    assert.equal(env.card().usd, PROPOSAL.usd);
    t.time.advance(FIVE_MINUTES);
    assert.equal(env.relay.requests().length, 13, 'only the one');
    assert.equal(t.store.get(id).reason, 'grant_pending');

    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), /a press on the phone is awaited/);
    assert.equal(env.relay.requests().length, 14);
    env.press();
    assert.equal(t.store.get(id).state, 'waiting');
    await t.manager.send(id, 'go on', { origin: FRONT });
    const turn = await t.started(2);
    assert.deepEqual(await turn.options.executorOptions.taskPolicy.decide(...BASH), { allow: true });
  });

  it('grant_pending over the cap: the raise goes past the spend, its press answers both, and a send runs', async () => {
    const { t, id, turn } = await underWay({ script: [reply('STUCK: a wall'), untilAborted] });
    await t.settled(t.manager, id);
    turn.usage({ costUsd: 3 });
    for (let n = 0; n < 12; n += 1) t.time.advance(FIVE_MINUTES);
    assert.equal(t.store.get(id).reason, 'grant_pending');
    await assert.rejects(t.manager.send(id, 'go', { origin: FRONT }), /spend cap; a press on the phone is awaited/);
    assert.equal(env.card().usd, 4);
    env.press();
    const rec = t.store.get(id);
    assert.equal(rec.spend.cap_usd, 4);
    assert.equal(rec.reason, null, 'the press answered it');
    await t.manager.send(id, 'go', { origin: FRONT });
    await t.started(2);
  });

  it('a late bill past a card that is out: the send replaces it with one that goes past the spend', async () => {
    const { t, id, turn } = await underWay({ script: [reply('STUCK: a wall')] });
    await t.settled(t.manager, id);
    const first = env.leaseId();
    turn.usage({ costUsd: 3 });
    assert.equal(env.card().usd, 2);
    await assert.rejects(t.manager.send(id, 'go', { origin: FRONT }), /a press on the phone is awaited/);
    assert.notEqual(env.leaseId(), first);
    assert.equal(env.card().usd, 4);
    const cards = env.relay.requests().length;
    await assert.rejects(t.manager.send(id, 'go', { origin: FRONT }), /a press on the phone is awaited/);
    assert.equal(env.relay.requests().length, cards, 'this one covers it');
  });

  it('a press on grant_pending\'s one more card clears the reason, and a later send past its minutes asks anew', async () => {
    const { t, id } = await underWay({ script: [reply('STUCK: a wall')] });
    await t.settled(t.manager, id);
    for (let n = 0; n < 12; n += 1) t.time.advance(FIVE_MINUTES);
    await assert.rejects(t.manager.send(id, 'go', { origin: FRONT }), /press/);
    env.press({ minutes: 5 });
    assert.equal(t.store.get(id).reason, null);
    t.time.advance(FIVE_MINUTES);
    const cards = env.relay.requests().length;
    await assert.rejects(t.manager.send(id, 'go', { origin: FRONT }), /press/);
    assert.equal(env.relay.requests().length, cards + 1);
  });

  it('grant_pending with no phone: the send says so truly, ends the task, and frees the node', async () => {
    const { t, id } = await underWay({ script: [reply('STUCK: a wall')] });
    await t.settled(t.manager, id);
    for (let n = 0; n < 12; n += 1) t.time.advance(FIVE_MINUTES);
    env.approval.on = false;
    const cards = env.relay.requests().length;
    await assert.rejects(t.manager.send(id, 'go', { origin: FRONT }), (err) => {
      assert.equal(err.code, 'invalid_params');
      assert.doesNotMatch(err.message, /press/);
      return true;
    });
    assert.equal(env.relay.requests().length, cards);
    const rec = t.store.get(id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.ended.reason, 'duration');
    assert.equal(t.manager.handles.size, 0);
    await t.manager.run({ text: 'the node is free', origin: FRONT });
  });

  it('a press after the unpressed minutes moves the deadline; the task waits for a send', async () => {
    const { t, id } = await underWay({ script: [untilAborted, untilAborted] });
    t.time.advance(FIVE_MINUTES);
    t.time.advance(FIVE_MINUTES);
    t.time.advance(FIVE_MINUTES);
    t.time.advance(FIVE_MINUTES);
    await t.settled(t.manager, id);
    assert.equal(t.store.get(id).reason, 'duration');
    const cards = env.relay.requests().length;
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), /press/);
    assert.equal(env.relay.requests().length, cards, 'the card that is out is the card');
    env.press();
    const rec = t.store.get(id);
    assert.deepEqual([rec.state, rec.reason], ['waiting', null]);
    assert.equal(rec.deadline_at, rec.grant.expires_at);
    await t.manager.send(id, 'go on', { origin: FRONT });
    await t.started(2);
  });

  it('a turn that ends with the card out: a press leaves it waiting, and the grant covers the next send', async () => {
    const { t, id } = await underWay({ script: [reply('STUCK: a wall'), untilAborted] });
    await t.settled(t.manager, id);
    assert.equal(t.store.get(id).state, 'waiting');
    assert.equal(t.store.get(id).reason, 'stuck');
    env.press();
    assert.equal(t.store.get(id).state, 'waiting');
    assert.ok(t.store.get(id).grant);
    await t.manager.send(id, 'go on', { origin: FRONT });
    const turn = await t.started(2);
    assert.deepEqual(await turn.options.executorOptions.taskPolicy.decide(...BASH), { allow: true });
  });

  it('card held while the link is down: the task reads, get says awaiting_grant, a link-up delivers the live card, and no acting call ran', async () => {
    env.relay.down();
    const { t, id, policy } = await underWay();
    assert.equal(env.relay.requests().length, 0);
    assert.equal((await t.manager.get(id)).state, 'awaiting_grant');
    assert.deepEqual(await policy.decide('Read', { file_path: 'a' }, {}), { passthrough: true });
    const decided = policy.decide(...BASH);
    assert.equal(await pendingAfterTicks(decided), true);
    env.relay.up();
    assert.equal(env.relay.requests().length, 1);
    assert.equal(await pendingAfterTicks(decided), true, 'delivered is not pressed');
    env.press();
    assert.deepEqual(await decided, { allow: true });
  });

  it('re-sends go on while the link is down, and the link-up delivers only the live one', async () => {
    env.relay.down();
    const { t, id } = await underWay();
    t.time.advance(FIVE_MINUTES);
    assert.equal(t.store.get(id).card_sends, 2);
    env.relay.up();
    assert.equal(env.relay.requests().length, 1);
    assert.equal(env.relay.lastRequest().message.lease_id, env.leases.current().leaseId);
  });
});

describe('a lease that ends under a running task', () => {
  it('expiry gives grant: null at once, and the turn is cut duration even past the turn\'s own deadline', async () => {
    const { t, id, turn, policy } = await underWay({ script: [reply('STUCK: a wall'), untilAborted] });
    await t.settled(t.manager, id);
    env.press({ minutes: 5 });
    t.time.advance(4 * 60000);
    await t.manager.send(id, 'go on', { origin: FRONT });
    assert.deepEqual(await policy.decide(...BASH), { allow: true });
    const next = await t.started(2);
    t.time.advance(60000);
    assert.equal((await policy.decide(...BASH)).passthrough, true);
    assert.equal(next.options.abortSignal.aborted, true);
    assert.equal(turn.options.abortSignal.aborted, false, 'the first turn was already over');
    const rec = await t.settled(t.manager, id);
    assert.equal(rec.state, 'waiting');
    assert.equal(rec.reason, 'duration');
  });

  it('a lease past its time gives grant: null before its timer has run', async () => {
    const { t, policy } = await underWay();
    env.press({ minutes: 5 });
    assert.deepEqual(await policy.decide(...BASH), { allow: true });
    env.leases.find(env.leaseId()).expiresAt = t.time.clock();
    assert.equal((await policy.decide(...BASH)).passthrough, true);
  });

  it('expiry with no turn running changes nothing of the task', async () => {
    const { t, id } = await underWay({ script: [reply('STUCK: a wall')] });
    await t.settled(t.manager, id);
    env.press({ minutes: 5 });
    const before = t.store.get(id);
    t.time.advance(FIVE_MINUTES);
    const rec = t.store.get(id);
    assert.equal(rec.state, 'waiting');
    assert.equal(rec.reason, 'stuck');
    assert.equal(rec.seq, before.seq);
  });

  it('after an expired lease a send is refused and a card goes; only its press moves the deadline', async () => {
    const { t, id } = await underWay({ script: [reply('STUCK: a wall'), untilAborted] });
    await t.settled(t.manager, id);
    env.press({ minutes: 5 });
    t.time.advance(FIVE_MINUTES);
    const before = t.store.get(id);
    const cards = env.relay.requests().length;
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), /a press on the phone is awaited/);
    assert.equal(env.relay.requests().length, cards + 1);
    assert.equal(env.card().usd, before.spend.cap_usd);
    assert.deepEqual(env.card().allows, PROPOSAL.allows);
    assert.equal(t.store.get(id).deadline_at, before.deadline_at);
    assert.equal(t.calls.length, 1);
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), code('invalid_params'));
    assert.equal(env.relay.requests().length, cards + 1, 'not while one is out');
    env.press();
    const pressed = t.store.get(id);
    assert.equal(pressed.state, 'waiting');
    assert.equal(pressed.deadline_at, pressed.grant.expires_at);
    assert.equal(pressed.spend.cap_usd, before.spend.cap_usd);
    await t.manager.send(id, 'go on', { origin: FRONT });
    const turn = await t.started(2);
    assert.deepEqual(await turn.options.executorOptions.taskPolicy.decide(...BASH), { allow: true });
  });

  it('a look-only task on waiting, duration: the card is read only; a deny ends it duration', async () => {
    const { t, id } = await underWay({ callUtility: answer({ sites: [], allows: [], minutes: 20, usd: 2 }), script: [untilAborted] });
    t.time.advance(20 * 60000);
    const rec = await t.settled(t.manager, id);
    assert.equal(rec.reason, 'duration');
    assert.equal(env.relay.requests().length, 0);
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), /press/);
    assert.deepEqual(env.card().allows, []);
    env.press({ decision: 'deny' });
    assert.equal(t.store.get(id).state, 'cancelled');
    assert.equal(t.store.get(id).ended.reason, 'duration');
  });

  it('a time card nobody answers leaves it waiting, duration, and a send asks again', async () => {
    const { t, id } = await underWay({ callUtility: answer({ sites: [], allows: [], minutes: 20, usd: 2 }), script: [untilAborted] });
    t.time.advance(20 * 60000);
    await t.settled(t.manager, id);
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), /press/);
    for (let n = 0; n < 12; n += 1) t.time.advance(FIVE_MINUTES);
    assert.equal(env.leases.current(), null);
    assert.equal(t.store.get(id).reason, 'duration');
    const cards = env.relay.requests().length;
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), /press/);
    assert.equal(env.relay.requests().length, cards + 1);
  });

  it('a time card that cannot go ends the task failed, duration', async () => {
    const { t, id } = await underWay({ callUtility: answer({ sites: [], allows: [], minutes: 20, usd: 2 }), script: [untilAborted] });
    t.time.advance(20 * 60000);
    await t.settled(t.manager, id);
    env.approval.on = false;
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), code('invalid_params'));
    await tick();
    assert.equal(t.store.get(id).state, 'failed');
    assert.equal(t.store.get(id).ended.reason, 'duration');
  });

  it('a follow-up on done past the deadline is refused plainly: no card, no change', async () => {
    const { t, id } = await underWay({ script: [reply('all done')] });
    const rec = await t.settled(t.manager, id);
    t.time.advance(30 * 60000);
    const cards = env.relay.requests().length;
    await assert.rejects(t.manager.send(id, 'more', { origin: FRONT }), (err) => {
      assert.equal(err.code, 'invalid_params');
      assert.doesNotMatch(err.message, /press/);
      return true;
    });
    assert.equal(env.relay.requests().length, cards);
    assert.equal(t.store.get(id).seq, rec.seq);
  });

  it('a follow-up on done has no grant: acts ask per call, with no card', async () => {
    const { t, id } = await underWay({ script: [reply('all done'), untilAborted] });
    env.press();
    const rec = await t.settled(t.manager, id);
    assert.equal(rec.state, 'done');
    const cards = env.relay.requests().length;
    await t.manager.send(id, 'one more thing', { origin: FRONT });
    const turn = await t.started(2);
    assert.equal(env.relay.requests().length, cards);
    assert.equal((await turn.options.executorOptions.taskPolicy.decide(...BASH)).passthrough, true);
  });
});

describe('the spend raise', () => {
  const overCap = async (turn) => {
    turn.usage({ costUsd: 3 });
    await turn.aborted();
    return { type: 'stopped', content: '' };
  };
  // A turn that goes over its cap when the test says.
  const heldOverCap = () => {
    let charge;
    const gate = new Promise((resolve) => { charge = resolve; });
    return { charge, step: async (turn) => { await gate; return overCap(turn); } };
  };

  it('at the cap the lease ends spend_cap and a fresh request has usd doubled; a press leaves waiting with the new cap, and send starts the next turn', async () => {
    const { charge, step } = heldOverCap();
    const { t, id } = await underWay({ script: [step, reply('after the raise')] });
    env.press();
    const first = env.leaseId();
    assert.equal(t.store.get(id).grant.lease_id, first);
    charge();
    await tick();
    await t.settled(t.manager, id);
    let rec = t.store.get(id);
    assert.equal(rec.state, 'waiting');
    assert.equal(rec.reason, 'spend_cap');
    assert.equal(env.leases.find(first).endReason, 'spend_cap');
    assert.notEqual(env.leaseId(), first);
    assert.equal(env.card().usd, 4);
    assert.equal(env.card().resumes, null);
    assert.deepEqual(env.card().allows, ['browser-act', 'shell']);

    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), (err) => {
      assert.equal(err.code, 'invalid_params');
      assert.match(err.message, /spend cap/);
      assert.match(err.message, /press/);
      return true;
    });
    assert.equal(t.calls.length, 1);

    env.press();
    rec = t.store.get(id);
    assert.equal(rec.state, 'waiting');
    assert.equal(rec.reason, null, 'the press answered it');
    assert.equal(rec.spend.cap_usd, 4);
    assert.equal(rec.grant.lease_id, env.leaseId());

    await t.manager.send(id, 'go on', { origin: FRONT });
    rec = await t.settled(t.manager, id);
    assert.equal(rec.state, 'done');
    assert.equal(rec.answer.text, 'after the raise');
  });

  it('a deny of the raise ends the task spend_cap, with the push', async () => {
    const { t, id } = await underWay({ script: [overCap] });
    await t.settled(t.manager, id);
    assert.equal(env.card().usd, 4);
    env.press({ decision: 'deny' });
    const rec = t.store.get(id);
    assert.equal(rec.state, 'cancelled');
    assert.equal(rec.ended.reason, 'spend_cap');
    assert.deepEqual(t.pushes, [{ kind: 'task_ended', id }]);
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), code('invalid_params'));
  });

  it('a look-only task gets a raise card that says read only, and its reading stays as it was', async () => {
    const { t, id, policy } = await underWay({
      callUtility: answer({ sites: [], allows: [], minutes: 20, usd: 2 }),
      script: [overCap, reply('read more')],
    });
    await t.settled(t.manager, id);
    assert.equal(env.relay.requests().length, 1);
    assert.deepEqual(env.card().allows, []);
    assert.equal(validateMessage('kl.lease.request', env.relay.lastRequest().message), null);
    env.press();
    assert.equal(t.store.get(id).spend.cap_usd, 4);
    assert.equal((await policy.decide('BrowserPage', { action: 'navigate', url: 'https://any.example.org/' }, {})).look, true);
    assert.equal((await policy.decide(...BASH)).passthrough, true);
    await t.manager.send(id, 'go on', { origin: FRONT });
    assert.equal((await t.settled(t.manager, id)).state, 'done');
  });

  it('a task with no proposal gets one too, for the default minutes', async () => {
    const { t, id } = await underWay({ callUtility: null, script: [overCap] });
    await t.settled(t.manager, id);
    assert.deepEqual([env.card().allows, env.card().sites, env.card().usd, env.card().max_minutes], [[], [], 4, 30]);
  });

  it('a raise with the first card still out replaces it', async () => {
    const { charge, step } = heldOverCap();
    const { t, id } = await underWay({ script: [step] });
    const first = env.leaseId();
    charge();
    await tick();
    await t.settled(t.manager, id);
    assert.notEqual(env.leaseId(), first);
    assert.equal(env.leases.find(first).endReason, 'spend_cap');
    assert.equal(t.store.get(id).state, 'waiting');
    assert.equal(t.store.get(id).reason, 'spend_cap');
  });

  it('a raise nobody answers leaves it spend_cap; a send refused then sends another card', async () => {
    const { t, id } = await underWay({ script: [overCap] });
    await t.settled(t.manager, id);
    for (let n = 0; n < 12; n += 1) t.time.advance(FIVE_MINUTES);
    const cards = env.relay.requests().length;
    assert.equal(cards, 1 + 12);
    assert.equal(env.leases.current(), null);
    assert.equal(t.store.get(id).reason, 'spend_cap');
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), code('invalid_params'));
    assert.equal(env.relay.requests().length, cards + 1);
    assert.equal(env.card().usd, 4);
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), code('invalid_params'));
    assert.equal(env.relay.requests().length, cards + 1, 'not while one is out');
    env.press();
    assert.equal(t.store.get(id).spend.cap_usd, 4);
  });

  it('a late bill past a raise that was pressed: the send is refused, and a higher card goes', async () => {
    const { t, id } = await underWay({ script: [overCap] });
    await t.settled(t.manager, id);
    env.press();
    const first = env.leaseId();
    assert.equal(t.store.get(id).spend.cap_usd, 4);
    t.store.update(id, { spend: { ...t.store.get(id).spend, usd: 5 } });
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), /a press on the phone/);
    assert.notEqual(env.leaseId(), first);
    assert.equal(env.leases.find(first).endReason, 'spend_cap');
    assert.equal(env.card().usd, 8);
  });

  it('a done task at its cap refuses a send plainly, a late bill included: no card, no lease, no change, one push', async () => {
    const { t, id, turn } = await underWay({ script: [reply('all done')] });
    env.press();
    await t.settled(t.manager, id);
    turn.usage({ costUsd: 3 });
    const rec = t.store.get(id);
    assert.equal(rec.state, 'done');
    assert.equal(rec.spend.usd, 3);
    const cards = env.relay.requests().length;
    await assert.rejects(t.manager.send(id, 'more', { origin: FRONT }), (err) => {
      assert.equal(err.code, 'invalid_params');
      assert.match(err.message, /spend cap/);
      assert.doesNotMatch(err.message, /press/);
      return true;
    });
    assert.equal(env.relay.requests().length, cards);
    assert.equal(env.leases.current(), null);
    assert.equal(t.manager.handles.size, 0);
    assert.equal(t.store.get(id).seq, rec.seq);
    assert.equal(t.pushes.length, 1);
    await t.manager.run({ text: 'the node is free', origin: FRONT });
  });

  it('at $500 a send ends the task, and the refusal does not say a press is awaited', async () => {
    const { t, id } = await underWay({ script: [reply('STUCK: a wall')] });
    await t.settled(t.manager, id);
    env.press();
    t.store.update(id, { spend: { ...t.store.get(id).spend, usd: 500, cap_usd: 500 } });
    await assert.rejects(t.manager.send(id, 'more', { origin: FRONT }), (err) => {
      assert.match(err.message, /spend cap/);
      assert.doesNotMatch(err.message, /press/);
      return true;
    });
    assert.equal(t.store.get(id).state, 'failed');
    assert.equal(t.store.get(id).ended.reason, 'spend_cap');
  });

  it('with no phone to ask, a task at its cap ends failed, spend_cap: a client never raises spend with no press', async () => {
    const { charge, step } = heldOverCap();
    const { t, id } = await underWay({ script: [step] });
    env.approval.on = false;
    charge();
    await tick();
    await t.settled(t.manager, id);
    await tick();
    const rec = t.store.get(id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.ended.reason, 'spend_cap');
    assert.equal(t.pushes.length, 1);
  });

  describe('a raise card that could not go', () => {
    const atCap = async () => {
      const { charge, step } = heldOverCap();
      const u = await underWay({ script: [step, reply('after the raise')] });
      env.press();
      await tick();
      return { ...u, charge };
    };
    // Only the next request is refused: the card the test already pressed went.
    const refuseNext = (err) => {
      const real = env.leases.request;
      env.leases.request = async () => {
        env.leases.request = real;
        throw err;
      };
    };

    it('lease_busy leaves the task waiting; the next send raises again, and the press lets it go on', async () => {
      const { t, id, charge } = await atCap();
      refuseNext(new GuiError('lease_busy', 'another job holds this node\'s lease'));
      charge();
      await tick();
      await t.settled(t.manager, id);
      await tick();
      const cards = env.relay.requests().length;
      let rec = t.store.get(id);
      assert.deepEqual([rec.state, rec.reason, rec.ended], ['waiting', 'spend_cap', null]);
      assert.equal(t.pushes.length, 0, 'nothing ended');

      await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), (err) => {
        assert.equal(err.code, 'invalid_params');
        assert.match(err.message, /press/);
        return true;
      });
      assert.equal(env.relay.requests().length, cards + 1, 'the send raised again');
      assert.equal(env.card().usd, 4);
      env.press();
      await tick();
      rec = t.store.get(id);
      assert.deepEqual([rec.state, rec.reason, rec.spend.cap_usd], ['waiting', null, 4]);
      await t.manager.send(id, 'go on', { origin: FRONT });
      await t.settled(t.manager, id);
      assert.equal(t.store.get(id).state, 'done');
    });

    it('a send whose own raise is refused lease_busy says no card went, and ends nothing', async () => {
      const { t, id, charge } = await atCap();
      refuseNext(new GuiError('lease_busy', 'x'));
      charge();
      await tick();
      await t.settled(t.manager, id);
      await tick();
      refuseNext(new GuiError('lease_busy', 'x'));
      await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), (err) => {
        assert.equal(err.code, 'invalid_params');
        assert.ok(!/press on the phone is awaited/.test(err.message), err.message);
        assert.match(err.message, /send again/);
        return true;
      });
      const rec = t.store.get(id);
      assert.deepEqual([rec.state, rec.reason], ['waiting', 'spend_cap']);
    });

    for (const refused of ['approval_unavailable', 'capability_unavailable']) {
      it(`${refused} will not change: the task ends failed, spend_cap`, async () => {
        const { t, id, charge } = await atCap();
        refuseNext(new GuiError(refused, 'x'));
        charge();
        await tick();
        await t.settled(t.manager, id);
        await tick();
        const rec = t.store.get(id);
        assert.deepEqual([rec.state, rec.ended.reason], ['failed', 'spend_cap']);
      });
    }
  });

  it('a press on a raise of the time clears duration too, and wakes a waiting client', async () => {
    const t = env.harness({ callUtility: answer(PROPOSAL), script: [untilAborted, reply('more')] });
    const view = await t.manager.run({ text: 'Find a dentist', origin: FRONT });
    const id = view.task_id;
    await t.started();
    env.press();
    await tick();
    t.time.advance(21 * 60000);
    await t.settled(t.manager, id);
    assert.equal(t.store.get(id).reason, 'duration');
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), code('invalid_params'));
    const { seq } = t.store.get(id);
    const held = t.manager.get(id, { seenSeq: seq, waitMs: 20000 });
    env.press();
    const woke = await held;
    assert.ok(woke.seq > seq);
    assert.deepEqual([woke.state, woke.reason, woke.grant.live], ['waiting', null, true]);
    await t.manager.send(id, 'go on', { origin: FRONT });
    await t.settled(t.manager, id);
    assert.equal(t.store.get(id).state, 'done');
  });

  it('a press does not clear stuck: the question is still the owner\'s', async () => {
    const t = env.harness({ callUtility: answer(PROPOSAL), script: [reply('STUCK: which date?')] });
    const view = await t.manager.run({ text: 'Find a dentist', origin: FRONT });
    await t.settled(t.manager, view.task_id);
    env.press();
    await tick();
    assert.equal(t.store.get(view.task_id).reason, 'stuck');
  });

  it('the raise doubles past what is spent, up to 500; at 500 nothing can raise it', async () => {
    assert.equal(raisedUsd({ usd: 3, cap_usd: 2 }), 4);
    assert.equal(raisedUsd({ usd: 9, cap_usd: 2 }), 16);
    assert.equal(raisedUsd({ usd: 301, cap_usd: 300 }), 500);
    assert.equal(raisedUsd({ usd: 500, cap_usd: 500 }), null);
    assert.equal(raisedUsd({ usd: 600, cap_usd: 300 }), null);
    assert.equal(raisedUsd({ usd: 2.5, cap_usd: 2 }), 4);
  });

  it('at a cap nothing can raise, the task ends failed, spend_cap', async () => {
    const { t, id } = await underWay({
      script: [async (turn) => {
        turn.usage({ costUsd: 500 });
        await turn.aborted();
        return { type: 'stopped', content: '' };
      }],
    });
    await t.settled(t.manager, id);
    assert.equal(t.store.get(id).state, 'failed');
    assert.equal(t.store.get(id).ended.reason, 'spend_cap');
    assert.equal(env.leases.current(), null);
  });
});

describe('with no press, a proposal binds nothing', () => {
  const BIG = { sites: ['a.example.com'], allows: [], minutes: 240, usd: 50 };

  it('look-only: $2 and at most 30 minutes, with the proposal kept as proposed; a raise goes higher', async () => {
    const { t, id } = await underWay({ callUtility: answer(BIG) });
    const rec = t.store.get(id);
    assert.equal(rec.proposal.usd, 50);
    assert.equal(rec.proposal.minutes, 240);
    assert.equal(rec.spend.cap_usd, 2);
    assert.equal(rec.deadline_at, new Date(t.time.clock() + 30 * 60000).toISOString());
    assert.equal(env.relay.requests().length, 0);
    t.calls[0].usage({ costUsd: 3 });
    await t.settled(t.manager, id);
    assert.deepEqual([env.card().allows, env.card().usd, env.card().max_minutes], [[], 4, 240]);
    env.press({ minutes: 240 });
    assert.equal(t.store.get(id).spend.cap_usd, 4);
    assert.equal(t.store.get(id).deadline_at, t.store.get(id).grant.expires_at);
  });

  it('a look-only proposal under the bound keeps its own minutes', async () => {
    const { t, id } = await underWay({ callUtility: answer({ ...BIG, minutes: 10 }) });
    assert.equal(t.store.get(id).deadline_at, new Date(t.time.clock() + 10 * 60000).toISOString());
  });

  it('grants: null: the same, whatever the proposal says', async () => {
    const { t, id } = await underWay({ grants: null, callUtility: answer({ ...BIG, allows: ['shell'] }) });
    const rec = t.store.get(id);
    assert.equal(rec.proposal.usd, 50);
    assert.equal(rec.spend.cap_usd, 2);
    assert.equal(rec.deadline_at, new Date(t.time.clock() + 30 * 60000).toISOString());
  });

  it('a null proposal: $2 and 30 minutes', async () => {
    const { t, id } = await underWay({ callUtility: async () => 'not json' });
    const rec = t.store.get(id);
    assert.equal(rec.spend.cap_usd, 2);
    assert.equal(rec.deadline_at, new Date(t.time.clock() + 30 * 60000).toISOString());
  });

  it('a card that cannot go: the proposal comes down to the same, and the turn is cut at it', async () => {
    env.approval.on = false;
    const { t, id, turn } = await underWay({ callUtility: answer({ ...BIG, allows: ['shell'] }) });
    await tick();
    const rec = t.store.get(id);
    assert.equal(rec.state, 'running');
    assert.equal(rec.proposal.usd, 50);
    assert.equal(rec.spend.cap_usd, 2);
    assert.equal(rec.deadline_at, new Date(t.time.clock() + 30 * 60000).toISOString());
    t.time.advance(30 * 60000);
    assert.equal(turn.options.abortSignal.aborted, true);
  });

  it('a card that is out: $2 and 30 minutes until the press, which sets the card\'s usd and the lease\'s expiry', async () => {
    const { t, id, turn } = await underWay({ callUtility: answer({ ...BIG, allows: ['shell'] }) });
    let rec = t.store.get(id);
    assert.equal(rec.state, 'awaiting_grant');
    assert.equal(rec.proposal.usd, 50);
    assert.equal(rec.spend.cap_usd, 2);
    assert.equal(rec.deadline_at, new Date(t.time.clock() + 30 * 60000).toISOString());
    assert.deepEqual([env.card().usd, env.card().max_minutes], [50, 240]);
    t.time.advance(FIVE_MINUTES);
    env.press({ minutes: 240 });
    rec = t.store.get(id);
    assert.equal(rec.spend.cap_usd, 50);
    assert.equal(rec.deadline_at, rec.grant.expires_at);
    assert.equal(Date.parse(rec.grant.expires_at), t.time.clock() + 240 * 60000);
    t.time.advance(30 * 60000);
    assert.equal(turn.options.abortSignal.aborted, false);
  });

  it('a card that is out, unpressed: the turn is cut at $2, and the raise card says what the proposal asked', async () => {
    const { t, id, turn } = await underWay({ callUtility: answer({ ...BIG, allows: ['shell'], usd: 10 }) });
    turn.usage({ costUsd: 2 });
    assert.equal(turn.options.abortSignal.aborted, true);
    await t.settled(t.manager, id);
    assert.deepEqual([t.store.get(id).state, t.store.get(id).reason], ['waiting', 'spend_cap']);
    assert.equal(env.card().usd, 10);
    env.press({ minutes: 240 });
    assert.equal(t.store.get(id).spend.cap_usd, 10);
  });

  it('a card that is out, unpressed: the turn is cut at 30 minutes, and the card goes on', async () => {
    const { t, id, turn } = await underWay({ callUtility: answer({ ...BIG, allows: ['shell'] }) });
    for (let n = 0; n < 6; n += 1) t.time.advance(FIVE_MINUTES);
    assert.equal(turn.options.abortSignal.aborted, true);
    await t.settled(t.manager, id);
    assert.deepEqual([t.store.get(id).state, t.store.get(id).reason], ['waiting', 'duration']);
    assert.equal(env.leases.current().state, 'pending');
  });

  it('a re-proposal with no card, after a card nobody pressed, stays at $2', async () => {
    const utility = [JSON.stringify({ ...BIG, allows: ['shell'] }), JSON.stringify(BIG)];
    const { t, id } = await underWay({ callUtility: async () => utility.shift(), script: [untilAborted, untilAborted] });
    assert.equal(t.store.get(id).spend.cap_usd, 2);
    await t.manager.stop();
    t.manager = t.build();
    await t.manager.start();
    await t.manager.send(id, 'go on', { origin: FRONT });
    await t.started(2);
    assert.equal(t.store.get(id).spend.cap_usd, 2);
  });
});

describe('the cards that no longer count, and the waits that end', () => {
  it('a press on a superseded card does nothing', async () => {
    const { t, id } = await underWay();
    const old = env.relay.lastRequest().envelope;
    t.time.advance(FIVE_MINUTES);
    const signedAt = new Date(t.time.clock()).toISOString();
    const answered = env.leases.onGrant(env.phone.leaseGrant(old, { minutes: 20, apps: [], signedAt }));
    assert.equal(answered.state, 'rejected');
    const rec = t.store.get(id);
    assert.equal(rec.grant, null);
    assert.equal(rec.state, 'awaiting_grant');
    assert.equal(env.leases.current().state, 'pending');
    assert.equal(env.press().state, 'active');
    assert.equal(t.store.get(id).grant.lease_id, env.leaseId());
  });

  it('a press on a card after a cancel does nothing', async () => {
    const { t, id } = await underWay();
    await t.manager.cancel(id);
    const before = t.store.get(id);
    assert.equal(env.press().state, 'rejected');
    assert.equal(env.leases.current(), null);
    assert.equal(t.store.get(id).seq, before.seq);
    assert.equal(t.store.get(id).grant, null);
  });

  it('manager.stop wakes a waiting decide, which gets task_ended', async () => {
    const { t, policy } = await underWay();
    const decided = policy.decide(...BASH);
    assert.equal(await pendingAfterTicks(decided), true);
    await t.manager.stop();
    assert.equal((await decided).code, 'task_ended');
  });

  it('reading a handle changes nothing: the revoked device is the policy\'s and the send\'s to find', async () => {
    const { t, id, policy } = await underWay();
    env.press();
    env.approvers.isActive = () => false;
    assert.ok(t.manager.handles.get(id).state().grant);
    assert.equal(t.store.get(id).state, 'running');
    assert.equal((await policy.decide(...BASH)).code, 'task_ended');
  });

  it('a send that would run finds the revoked device first: refused, and the ending stands', async () => {
    const { t, id } = await underWay({ script: [reply('STUCK: a wall'), untilAborted] });
    await t.settled(t.manager, id);
    env.press();
    env.approvers.isActive = () => false;
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), /this task is cancelled/);
    const rec = t.store.get(id);
    assert.equal(rec.state, 'cancelled');
    assert.equal(rec.ended.reason, 'stopped');
    assert.equal(t.manager.turn, null);
    assert.equal(t.calls.length, 1);
    assert.equal(t.pushes.length, 1);
  });

  it('a send that would be refused finds it first: no new handle, no card, no lease', async () => {
    const { t, id, turn } = await underWay({ script: [reply('STUCK: a wall')] });
    await t.settled(t.manager, id);
    env.press();
    turn.usage({ costUsd: 3 });
    const cards = env.relay.requests().length;
    env.approvers.isActive = () => false;
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), /this task is cancelled/);
    assert.equal(t.store.get(id).ended.reason, 'stopped');
    assert.equal(env.relay.requests().length, cards);
    assert.equal(env.leases.current(), null);
    assert.equal(t.manager.handles.size, 0);
  });

  it('a device revoked out of band gives no allow, on the very next call', async () => {
    const { t, id, policy } = await underWay();
    env.press();
    assert.deepEqual(await policy.decide(...BASH), { allow: true });
    env.approvers.isActive = () => false;
    assert.equal((await policy.decide(...BASH)).code, 'task_ended');
    assert.equal(t.store.get(id).ended.reason, 'stopped');
    assert.equal(env.leases.find(env.leaseId()).endReason, 'device_revoked');
  });
});

describe('a restart', () => {
  it('re-cards: an interrupted task\'s send re-proposes and sends a card before the turn\'s first acting call', async () => {
    const proposals = [];
    const callUtility = async (prompt) => {
      proposals.push(prompt);
      return JSON.stringify(PROPOSAL);
    };
    const { t, id } = await underWay({ callUtility, script: [untilAborted, untilAborted] });
    env.press();
    const first = env.leaseId();
    await t.manager.stop();
    assert.equal(t.store.get(id).state, 'interrupted');
    assert.equal(env.leases.find(first).state, 'ended');

    const next = t.build();
    t.manager = next;
    await next.start();
    const view = await next.send(id, 'go on', { origin: FRONT });
    assert.equal(view.state, 'running');
    const turn = await t.started(2);
    assert.equal(proposals.length, 2);
    assert.match(proposals[1], /Find a dentist/);
    assert.match(proposals[1], /go on/);
    assert.notEqual(env.leaseId(), first);
    assert.equal(t.store.get(id).state, 'awaiting_grant');
    const decided = turn.options.executorOptions.taskPolicy.decide(...BASH);
    assert.equal(await pendingAfterTicks(decided), true, 'before any acting call runs');
    env.press();
    assert.deepEqual(await decided, { allow: true });
  });

  it('a re-proposal never moves a pressed cap: the card says the cap that stands', async () => {
    const utility = [JSON.stringify(PROPOSAL), JSON.stringify({ ...PROPOSAL, usd: 50 })];
    const { t, id } = await underWay({ callUtility: async () => utility.shift(), script: [untilAborted, untilAborted] });
    env.press();
    await t.manager.stop();
    t.manager = t.build();
    await t.manager.start();
    await t.manager.send(id, 'go on', { origin: FRONT });
    await t.started(2);
    assert.equal(t.store.get(id).spend.cap_usd, 2);
    assert.equal(env.card().usd, 2);
  });

  it('a re-proposal with no press yet: the card says what it proposes, and the cap stays $2 until pressed', async () => {
    const utility = [JSON.stringify(PROPOSAL), JSON.stringify({ ...PROPOSAL, usd: 50 })];
    const { t, id } = await underWay({ callUtility: async () => utility.shift(), script: [untilAborted, untilAborted] });
    await t.manager.stop();
    t.manager = t.build();
    await t.manager.start();
    await t.manager.send(id, 'go on', { origin: FRONT });
    await t.started(2);
    assert.equal(env.card().usd, 50);
    assert.equal(t.store.get(id).spend.cap_usd, 2);
    env.press();
    assert.equal(t.store.get(id).spend.cap_usd, 50);
  });

  it('a re-proposal that fails keeps the proposal the task had, and still cards', async () => {
    const utility = [JSON.stringify(PROPOSAL)];
    const { t, id } = await underWay({ callUtility: async () => utility.shift() || 'not json', script: [untilAborted, untilAborted] });
    const cards = env.relay.requests().length;
    await t.manager.stop();
    t.manager = t.build();
    await t.manager.start();
    await t.manager.send(id, 'go on', { origin: FRONT });
    await t.started(2);
    assert.deepEqual(t.store.get(id).proposal.sites, PROPOSAL.sites);
    assert.equal(env.relay.requests().length, cards + 1);
  });

  it('a waiting task from the last run has no lease either: its send re-cards', async () => {
    const { t, id } = await underWay({ script: [reply('STUCK: a wall'), untilAborted] });
    await t.settled(t.manager, id);
    env.press();
    await t.manager.stop();
    t.manager = t.build();
    await t.manager.start();
    assert.equal(t.store.get(id).state, 'waiting');
    await t.manager.send(id, 'go on', { origin: FRONT });
    await t.started(2);
    assert.equal(t.store.get(id).state, 'awaiting_grant');
    assert.equal(env.leases.current().state, 'pending');
  });

  it('an interrupted task over its cap: the send is refused and the raise card goes', async () => {
    const { t, id } = await underWay({
      script: [async (turn) => {
        turn.usage({ costUsd: 1 });
        await turn.aborted();
        return { type: 'stopped', content: '' };
      }],
    });
    await t.manager.stop();
    const rec = t.store.get(id);
    t.store.update(id, { spend: { ...rec.spend, usd: 3 } });
    t.manager = t.build();
    await t.manager.start();
    await assert.rejects(t.manager.send(id, 'go on', { origin: FRONT }), code('invalid_params'));
    assert.equal(env.card().usd, 4);
    env.press();
    assert.equal(t.store.get(id).spend.cap_usd, 4);
    const cards = env.relay.requests().length;
    await t.manager.send(id, 'go on', { origin: FRONT });
    assert.equal(env.relay.requests().length, cards, 'the press was the card: no second one');
    await t.settled(t.manager, id);
  });
});

describe('the handle alone', () => {
  const task = () => ({ task_id: 't1', chat_id: 'c1', text: 'Find a dentist', client: { kind: 'stdio' } });
  const ORIGIN = { client: 'stdio-mcp', session: null, job_id: 'chat:c1' };

  it('wait resolves on close, and close is safe twice; nothing is told after it', async () => {
    const changes = [];
    const handle = env.grants.open({ task: task(), proposal: PROPOSAL, origin: ORIGIN, onChange: (c) => changes.push(c.kind) });
    assert.deepEqual(handle.state(), { awaiting: true, grant: null });
    const waited = handle.wait();
    assert.equal(await pendingAfterTicks(waited), true);
    handle.close('cancelled');
    await waited;
    handle.close('cancelled');
    assert.deepEqual(handle.state(), { awaiting: false, grant: null });
    assert.equal(env.leases.current(), null);
    assert.deepEqual(changes, ['card']);
    handle.resend();
    handle.raise({ usd: 4, minutes: 20 });
    assert.equal(env.relay.requests().length, 1);
  });

  it('exposes the scope only while the lease is active', async () => {
    const changes = [];
    const handle = env.grants.open({ task: task(), proposal: PROPOSAL, origin: ORIGIN, onChange: (c) => changes.push(c) });
    env.press({ minutes: 5 });
    assert.deepEqual(handle.state(), { awaiting: false, grant: { sites: PROPOSAL.sites, allows: PROPOSAL.allows } });
    assert.equal(changes.at(-1).kind, 'granted');
    assert.equal(changes.at(-1).usd, 2);
    assert.equal(changes.at(-1).raise, false);
    env.time.advance(FIVE_MINUTES);
    assert.deepEqual(handle.state(), { awaiting: false, grant: null });
    assert.equal(changes.at(-1).kind, 'expired');
    handle.close('done');
  });

  it('ignores another lease\'s events', () => {
    const changes = [];
    const handle = env.grants.open({ task: task(), proposal: PROPOSAL, origin: ORIGIN, onChange: (c) => changes.push(c.kind) });
    env.leases.emit('state', { leaseId: 'another', state: 'ended', endReason: 'revoked' });
    assert.deepEqual(changes, ['card']);
    assert.equal(handle.state().awaiting, true);
    handle.close('done');
  });

  it('an onChange that throws costs nothing: the wait still ends', async () => {
    const handle = env.grants.open({ task: task(), proposal: PROPOSAL, origin: ORIGIN, onChange: () => { throw new Error('no'); } });
    const waited = handle.wait();
    env.press();
    await waited;
    assert.equal(handle.state().grant.allows.length, 2);
    handle.close('done');
  });

  it('resendLimit bounds the round', () => {
    const grants = new TaskGrants({ leases: env.leases, clock: env.time.clock, resendLimit: 2 });
    const changes = [];
    const handle = grants.open({ task: task(), proposal: PROPOSAL, origin: ORIGIN, onChange: (c) => changes.push(c.kind) });
    env.time.advance(FIVE_MINUTES);
    assert.equal(env.relay.requests().length, 2);
    env.time.advance(FIVE_MINUTES);
    assert.equal(env.relay.requests().length, 2);
    assert.deepEqual(changes, ['card', 'card', 'pending_exhausted']);
    assert.deepEqual(handle.state(), { awaiting: false, grant: null });
    handle.close('done');
  });
});
