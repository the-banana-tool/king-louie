// tests/cases-stop.test.js
// Stop appears in the case view while a turn runs (spec 2026-09-27 §9): the
// case runtime can report and abort its running turn, the chat's Stop reaches
// the case turn, and Stop on a case chat with no chat run stops a wake-up.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { CaseRuntime } = require('../src/cases');
const { chatHarness } = require('./helpers/chat-harness');

const HAS_GIT = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-case-stop-')); dirs.push(d); return d; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('CaseRuntime running turns', { skip: HAS_GIT ? false : 'git is not on PATH' }, () => {
  it('reports, notifies and aborts the running turn, of any source', async () => {
    const events = [];
    const rt = new CaseRuntime({ root: tmp(), host: { notify: (e, p) => events.push([e, p]), interactive: () => true } });
    const info = await rt.createCase({ title: 'Lakeside lot' });
    rt.store.updateMeta(info.id, { status: 'active' });
    assert.strictEqual(rt.runningTurn(info.id), null);
    assert.strictEqual(rt.abortTurn(info.id), false);

    const turn = await rt.beginTurn(info.id, { turnId: 'wakeup-1', source: 'wakeup' });
    assert.deepStrictEqual(rt.runningTurn(info.id), { turnId: 'wakeup-1', source: 'wakeup' });
    assert.ok(events.some(([e, p]) => e === 'case:changed' && p.caseId === info.id && p.what === 'turn' && p.running === true && p.source === 'wakeup'));

    assert.strictEqual(rt.abortTurn(info.id, 'stopped by owner'), true);
    assert.strictEqual(turn.signal.aborted, true);
    assert.strictEqual(turn.signal.reason, 'stopped by owner');

    await rt.endTurn(turn, { summary: 'stopped' });
    assert.strictEqual(rt.runningTurn(info.id), null);
    assert.ok(events.some(([e, p]) => e === 'case:changed' && p.what === 'turn' && p.running === false));

    const owner = await rt.beginTurn(info.id, { turnId: 'turn-1', source: 'owner' });
    assert.strictEqual(rt.abortTurn(info.id), true, 'owner turns too');
    assert.strictEqual(owner.signal.aborted, true);
    await rt.endTurn(owner, { summary: 'stopped' });
  });

  it('answers null and false for a case that does not exist', () => {
    const rt = new CaseRuntime({ root: tmp() });
    assert.strictEqual(rt.runningTurn('no-such-case'), null);
    assert.strictEqual(rt.abortTurn('no-such-case'), false);
  });
});

// A case runtime double for the chat path (like tests/cases-chat.test.js).
function fakeRuntime({ running = null } = {}) {
  const calls = { begin: [], end: [], aborted: [], turnAborts: [] };
  const runtime = {
    beginTurn: async (id, opts) => {
      calls.begin.push({ id, ...opts });
      return { caseId: id, dir: '/cases/lakeside-lot', turnId: opts.turnId, title: 'Lakeside lot', orientation: 'ORIENTATION', source: opts.source, triggers: [], abort: (reason) => calls.turnAborts.push(reason) };
    },
    runOwnerMessageHooks: async () => ({ notes: [], triggers: [] }),
    caseContext: (turn, extra) => ({ ...turn, ...extra }),
    routedProvider: (_turn, spec) => ({ getProviderName: () => spec.target.provider, sendMessageWithTools: async () => ({}) }),
    usageHook: () => () => {},
    endTurn: async (turn, opts) => { calls.end.push({ turn, ...opts }); },
    abortTurn: (caseId, reason) => { calls.aborted.push([caseId, reason]); return Boolean(running); },
    runningTurn: () => running
  };
  return { runtime, calls };
}

describe('Stop on a case chat', () => {
  it('Stop during an owner turn aborts the case turn too, and ends it as stopped', async () => {
    const { runtime, calls } = fakeRuntime();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let entered = false;
    class WaitingLoop {
      async run() { entered = true; await gate; return { type: 'stopped', content: '', llm: { calls: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } } }; }
    }
    const chat = { id: 'chat-1', title: 'Case chat', caseId: 'case-1', messages: [] };
    const h = chatHarness({
      provider: { sendMessageWithTools: async () => ({}) },
      chat,
      overrides: { getCaseRuntime: () => runtime, AgentLoop: WaitingLoop }
    });
    const sending = h.send({ message: 'What next?' });
    while (!entered) await tick();
    assert.deepStrictEqual(await h.stop(), { ok: true });
    assert.deepStrictEqual(calls.turnAborts, ['stopped by owner']);
    release();
    await sending;
    assert.strictEqual(calls.end.length, 1);
    assert.strictEqual(calls.end[0].summary, 'turn stopped by owner: What next?');
    assert.strictEqual(calls.end[0].journal, null);
    assert.strictEqual(chat.messages[chat.messages.length - 1].stopped, true);
  });

  it('Stop with no chat run stops the case\'s running wake-up turn', async () => {
    const { runtime, calls } = fakeRuntime({ running: { turnId: 'wakeup-1', source: 'wakeup' } });
    const h = chatHarness({ provider: {}, chat: { id: 'chat-1', title: 'Case chat', caseId: 'case-1', messages: [] }, overrides: { getCaseRuntime: () => runtime } });
    assert.deepStrictEqual(await h.stop(), { ok: true, caseTurn: true });
    assert.deepStrictEqual(calls.aborted, [['case-1', 'stopped by owner']]);
  });

  it('says there is nothing to stop when neither the chat nor its case is running', async () => {
    const { runtime } = fakeRuntime();
    const h = chatHarness({ provider: {}, chat: { id: 'chat-1', title: 'Case chat', caseId: 'case-1', messages: [] }, overrides: { getCaseRuntime: () => runtime } });
    assert.deepStrictEqual(await h.stop(), { ok: false, error: 'No active response for this chat.' });
  });

  // Targeted fix: activeRuns is registered right after beginTurn, before the
  // prompt hook runs (final review I2) — a hook that denies the turn used to
  // return with that entry still in activeRuns, since nothing on the
  // hook-deny exit path removed it. A following Stop found that stale entry
  // and returned { ok: true } without aborting anything real, and never
  // reached the case's own wake-up fallback below it. The `finally` added
  // in the targeted fix removes this run's own controller on every exit,
  // including a hook deny.
  it('a hook-denied send leaves no stale activeRuns entry: a following Stop reaches the wake-up fallback', async () => {
    const { runtime, calls } = fakeRuntime({ running: { turnId: 'wakeup-1', source: 'wakeup' } });
    const h = chatHarness({
      provider: { streamMessage: async () => ({}) },
      chat: { id: 'chat-1', title: 'Case chat', caseId: 'case-1', messages: [] },
      overrides: { getCaseRuntime: () => runtime, runHookEvent: async () => ({ action: 'deny', message: 'blocked by hook' }) }
    });
    const result = await h.send({ agentMode: false });
    assert.strictEqual(result.ok, false, 'the hook denied the turn');
    assert.deepStrictEqual(await h.stop(), { ok: true, caseTurn: true }, 'Stop reaches the wake-up fallback, not a stale entry');
    assert.deepStrictEqual(calls.aborted, [['case-1', 'stopped by owner']]);
  });

  // Targeted fix: activeRuns is a Set per chat, so more than one concurrent
  // send for the same chat is tracked at once, and Stop — which has no way
  // to target just one of them — aborts every controller in the set. Each
  // run's own AbortController must actually be aborted (not just its reply
  // eventually landing marked stopped some other way), so this captures
  // each run's own loop options and checks its abortSignal directly.
  it('two concurrent sends for the same chat are both stopped by one Stop', async () => {
    const { runtime } = fakeRuntime();
    let releaseFirst;
    let releaseSecond;
    let enteredFirst;
    let enteredSecond;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
    const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
    const secondEntered = new Promise((resolve) => { enteredSecond = resolve; });
    const loopOptionsByRun = [];
    let started = 0;
    class WaitingLoop {
      constructor(_provider, _executor, loopOptions = {}) {
        loopOptionsByRun.push(loopOptions);
      }

      async run() {
        const n = started++;
        if (n === 0) { enteredFirst(); await firstGate; } else { enteredSecond(); await secondGate; }
        return { type: 'stopped', content: '', llm: { calls: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } } };
      }
    }
    const chat = { id: 'chat-1', title: 'Case chat', caseId: 'case-1', messages: [] };
    const h = chatHarness({
      provider: { sendMessageWithTools: async () => ({}) },
      chat,
      overrides: { getCaseRuntime: () => runtime, AgentLoop: WaitingLoop }
    });
    const first = h.send({ message: 'first' });
    await firstEntered;
    const second = h.send({ message: 'second' });
    await secondEntered;
    assert.strictEqual(loopOptionsByRun.length, 2, 'both runs constructed their own AgentLoop');
    assert.notStrictEqual(loopOptionsByRun[0].abortSignal, loopOptionsByRun[1].abortSignal, 'each run has its own AbortController');
    assert.deepStrictEqual(await h.stop(), { ok: true });
    assert.strictEqual(loopOptionsByRun[0].abortSignal.aborted, true, 'the first run\'s own signal is aborted');
    assert.strictEqual(loopOptionsByRun[1].abortSignal.aborted, true, 'the second run\'s own signal is aborted too');
    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);
    const stoppedMessages = chat.messages.filter((m) => m.sender === 'assistant' && m.stopped);
    assert.strictEqual(stoppedMessages.length, 2, 'both sends end as stopped');
  });

  // Fix round 1: two chats can be attached to the same case. An owner turn
  // belongs to whichever chat's own run started it — that chat's own Stop
  // already covers it (it aborts its own abortController, which is wired to
  // the turn). Aborting the turn from a *different* chat's Stop (this
  // fallback, since that second chat has no run of its own) would abort the
  // turn's signal without ever touching the first chat's abortController,
  // leaving it half-stopped: still streaming into a turn that no longer
  // exists. A wake-up turn belongs to no chat's run, so it is still
  // stoppable this way.
  it('an owner turn on a case is not aborted by Stop from a second chat attached to the same case; a wake-up turn still is', async () => {
    const owner = fakeRuntime({ running: { turnId: 'turn-1', source: 'owner' } });
    const hOwnerCase = chatHarness({ provider: {}, chat: { id: 'chat-b', title: 'Case chat B', caseId: 'case-1', messages: [] }, overrides: { getCaseRuntime: () => owner.runtime } });
    assert.deepStrictEqual(await hOwnerCase.stop(), { ok: false, error: 'No active response for this chat.' });
    assert.deepStrictEqual(owner.calls.aborted, [], 'an owner turn must never be aborted through this fallback');

    const wakeup = fakeRuntime({ running: { turnId: 'wakeup-1', source: 'wakeup' } });
    const hWakeupCase = chatHarness({ provider: {}, chat: { id: 'chat-c', title: 'Case chat C', caseId: 'case-1', messages: [] }, overrides: { getCaseRuntime: () => wakeup.runtime } });
    assert.deepStrictEqual(await hWakeupCase.stop(), { ok: true, caseTurn: true });
    assert.deepStrictEqual(wakeup.calls.aborted, [['case-1', 'stopped by owner']]);
  });
});

describe('the case view shows Stop while a turn runs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

  it('tracks running case turns from case:changed and asks on chat switch', () => {
    assert.match(src, /runningCaseTurns: new Set\(\)/);
    assert.match(src, /payload\?\.what === 'turn'/);
    assert.match(src, /window\.electron\.cases\.runningTurn\(/);
  });

  it('shows Stop for a running case turn through one function', () => {
    assert.match(src, /function refreshStopButton\(\)/);
    assert.match(src, /appState\.runningCaseTurns\.has\(chat\.caseId\)/);
  });
});
