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
