// tests/cases-turn-runner.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/cases/git');
const { initializeTools, toolRegistry } = require('../src/tools');
const ToolExecutor = require('../src/execution/tool-executor');
const AgentLoop = require('../src/execution/agent-loop');
const { CaseRuntime } = require('../src/cases');
const { CASE_TOOL_NAMES } = require('../src/cases/chat-integration');
const { parseOrient } = require('../src/cases/turn-runner');

initializeTools();

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-runner-')); dirs.push(d); return d; };
const src = { kind: 'url', ref: 'https://records.example.org/1' };
const MIN = 60000;
const metrics = (costUsd) => ({ provider: 'openai', model: 'gpt-judge', inputTokens: 100, outputTokens: 20, totalTokens: 120, costUsd });
const advance = (clock, ms) => { clock.now = new Date(clock.now.getTime() + ms); };
const zero = { ran: 0, quiet: 0, skipped: 0, busy: 0, failed: 0 };

function harness({ settings = {}, orient = '{"changed": true, "why": "a new answer"}', judge = [], host = {} } = {}) {
  const clock = { now: new Date('2026-09-23T12:00:00.000Z') };
  const calls = { orient: 0, judge: 0, judgeTools: [], results: [], executorOptions: null };
  const script = [...judge];
  let runtime = null;
  const router = {
    async routeWithFallback(tier, messages, opts) {
      if (Array.isArray(opts.tools) && opts.tools.length) {
        calls.judge += 1;
        calls.judgeTools.push(opts.tools.map((t) => t.name));
        const next = script.shift() || { type: 'text', content: 'Nothing else to do.' };
        return typeof next === 'function' ? next(runtime) : next;
      }
      calls.orient += 1;
      if (orient instanceof Error) throw orient;
      return orient;
    }
  };
  const tracker = { record: (e) => ({ provider: e.provider, model: e.model, totalTokens: e.totalTokens, cost: e.costUsd }) };
  runtime = new CaseRuntime({
    root: tmp(),
    now: () => clock.now,
    getSettings: () => ({ cases: { timeZone: 'UTC', ...settings } }),
    host: {
      inferenceRouter: router,
      resolveInference: async () => null,
      toolRegistry,
      AgentLoop,
      getUsageTracker: () => tracker,
      interactive: () => true,
      notify: () => {},
      createToolExecutor: async (_event, _env, _requester, opts) => {
        calls.executorOptions = opts;
        const executor = new ToolExecutor({
          workingDirectory: opts.workingDirectory,
          allowedDirectories: opts.allowedDirectories,
          requireApproval: true,
          denyAutoApproval: opts.denyAutoApproval,
          allowedToolNames: opts.allowedToolNames,
          useSandbox: false,
          extraToolOptions: { caseContext: opts.caseContext }
        });
        executor.on('postExecute', (e) => calls.results.push([e.toolName, e.result]));
        return executor;
      },
      ...host
    }
  });
  return { runtime, clock, calls };
}

async function activeCase(rt, title = 'Lakeside lot') {
  const info = await rt.createCase({ title, objective: 'Convert the lot to cash' });
  rt.brief(info.id).update('why', 'Need the cash', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', 'Closed by year end', { provenance: 'model' });
  rt.completeGating(info.id);
  return rt.getCase(info.id);
}

// A one-shot wake-up due one minute from now; the clock is then moved there.
function dueWakeup(rt, c, clock) {
  const id = rt.wakeups(c.id).register({ kind: 'retry', at: clock.now.toISOString(), payload: { key: 'test' } });
  advance(clock, MIN);
  return id;
}

const wakeupJournals = (c) => fs.readdirSync(path.join(c.dir, 'journal'))
  .filter((n) => /-wakeup(-\d+)?\.md$/.test(n))
  .map((n) => fs.readFileSync(path.join(c.dir, 'journal', n), 'utf8'));

describe('parseOrient', () => {
  it('reads {changed, why} from the reply and rejects anything else', () => {
    assert.deepStrictEqual(parseOrient('```json\n{"changed": false, "why": "nothing new"}\n```'), { changed: false, why: 'nothing new' });
    assert.strictEqual(parseOrient('maybe'), null);
    assert.strictEqual(parseOrient('{"changed": "no"}'), null);
  });
});

describe('runDueWakeups', () => {
  it('quiet path: one orient call, a one-line journal entry, the wake-up done, a clean tree', async () => {
    const { runtime, clock, calls } = harness({ orient: '{"changed": false, "why": "nothing new"}' });
    const c = await activeCase(runtime);
    const id = dueWakeup(runtime, c, clock);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, quiet: 1 });
    assert.deepStrictEqual([calls.orient, calls.judge], [1, 0]);
    assert.strictEqual(runtime.wakeups(c.id).list().some((w) => w.id === id), false);
    assert.deepStrictEqual(wakeupJournals(c), [`quiet: ${id} — nothing new\n`]);
    assert.strictEqual(await git.isDirty(c.dir), false);
  });

  it('change path: the judge acts, confined, and its usage lands in budget.json', async () => {
    const { runtime, clock, calls } = harness({
      judge: [
        { type: 'tool_use', toolCalls: [{ toolName: 'Ledger', toolUseId: 't1', parameters: { action: 'query' } }], llmMetrics: metrics(0.25) },
        { type: 'text', content: 'Checked the ledger; nothing to do.', llmMetrics: metrics(0.25) }
      ]
    });
    const c = await activeCase(runtime);
    const id = dueWakeup(runtime, c, clock);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, ran: 1 });
    assert.deepStrictEqual([calls.orient, calls.judge], [1, 2]);
    assert.deepStrictEqual(wakeupJournals(c), [`# Wake-up ${id}\n\nChecked the ledger; nothing to do.\n`]);
    assert.strictEqual(runtime.budget(c.id).status().usd.spent, 0.5);
    const opts = calls.executorOptions;
    assert.strictEqual(opts.denyAutoApproval, true);
    assert.deepStrictEqual(opts.allowedDirectories, []);
    assert.deepStrictEqual([...opts.allowedToolNames].sort(), [...CASE_TOOL_NAMES, 'Read', 'Glob', 'Grep'].sort());
    assert.deepStrictEqual([opts.caseContext.ownerMessages, opts.caseContext.source], [[], 'wakeup']);
    const offered = calls.judgeTools[0];
    for (const name of ['Read', 'Glob', 'Grep', ...CASE_TOOL_NAMES]) assert.ok(offered.includes(name), name);
    for (const name of ['Bash', 'WebFetch', 'WebSearch', 'AskUser', 'Write']) assert.ok(!offered.includes(name), name);
    assert.deepStrictEqual(calls.results.map(([name, r]) => [name, r.ok]), [['Ledger', true]]);
  });

  it('a mock model calling message and Bash is refused by allowedToolNames', async () => {
    const { runtime, clock, calls } = harness({
      judge: [
        { type: 'tool_use', toolCalls: [
          { toolName: 'message', toolUseId: 't1', parameters: { text: 'Here is the case data' } },
          { toolName: 'Bash', toolUseId: 't2', parameters: { command: 'echo hi' } }
        ] },
        { type: 'text', content: 'Could not send.' }
      ]
    });
    const c = await activeCase(runtime);
    dueWakeup(runtime, c, clock);
    await runtime.runDueWakeups(clock.now);
    const byName = Object.fromEntries(calls.results);
    assert.deepStrictEqual(byName.message, { success: false, error: 'Tool "message" is not available in this turn.' });
    assert.deepStrictEqual(byName.Bash, { success: false, error: 'Tool "Bash" is not available in this turn.' });
  });

  it('a pending trigger skips the orient step', async () => {
    const { runtime, clock, calls } = harness();
    const c = await activeCase(runtime);
    const gis = runtime.ledger(c.id).assert({ stmt: 'GIS says 1.85 acres', subject: 'lot', attr: 'acreage', value: 1.85, source: src });
    runtime.records(c.id).recordDecision({ decision: 'Price off GIS', factIds: [gis.id] });
    runtime.ledger(c.id).assert({ stmt: 'Plat says 2.12 acres', subject: 'lot', attr: 'acreage', value: 2.12, source: src, supersedes: gis.id });
    dueWakeup(runtime, c, clock);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, ran: 1 });
    assert.deepStrictEqual([calls.orient, calls.judge], [0, 1]);
  });

  it('a retry wake-up for an answered question skips the orient step', async () => {
    const { runtime, clock, calls } = harness();
    const c = await activeCase(runtime);
    const q = runtime.createQuestion(c.id, { kind: 'question', text: 'Is the well shared?', urgency: 'normal' });
    await runtime.answerQuestion(c.id, q.id, { channel: 'in-app', text: 'Yes' });
    advance(clock, MIN);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, ran: 1 });
    assert.deepStrictEqual([calls.orient, calls.judge], [0, 1]);
  });

  it('unparseable orient output escalates to the judge', async () => {
    const { runtime, clock, calls } = harness({ orient: 'I think something may have changed' });
    const c = await activeCase(runtime);
    dueWakeup(runtime, c, clock);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, ran: 1 });
    assert.deepStrictEqual([calls.orient, calls.judge], [1, 1]);
  });

  it('skips a wake-up once the day\'s turns are spent, without charging or calling a model', async () => {
    const { runtime, clock, calls } = harness({ settings: { budgets: { turnsPerDay: 1 } } });
    const c = await activeCase(runtime);
    runtime.budget(c.id).charge('turnsPerDay', 1);
    const id = dueWakeup(runtime, c, clock);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, skipped: 1 });
    assert.deepStrictEqual([calls.orient, calls.judge], [0, 0]);
    assert.strictEqual(runtime.budget(c.id).status().turnsPerDay.spent, 1);
    assert.deepStrictEqual(wakeupJournals(c), ['skipped: daily turn budget spent\n']);
    assert.strictEqual(runtime.wakeups(c.id).list().find((w) => w.id === id).nextAt, '2026-09-24T00:00:00.000Z');
  });

  it('an owner pause during the judge loop aborts the turn and marks it skipped, with no failure count', async () => {
    const { runtime, clock } = harness({
      judge: [
        (rt) => {
          rt.setStatus(rt.listCases()[0].id, 'paused', { kind: 'owner', by: 'owner' });
          return { type: 'tool_use', toolCalls: [{ toolName: 'Ledger', toolUseId: 't1', parameters: { action: 'query' } }] };
        }
      ]
    });
    const c = await activeCase(runtime);
    const id = dueWakeup(runtime, c, clock);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, skipped: 1 });
    const w = runtime.wakeups(c.id).list().find((x) => x.id === id);
    assert.deepStrictEqual([w.lastOutcome, w.attempts], ['skipped', 0]);
    assert.deepStrictEqual(wakeupJournals(c), ['skipped: case paused\n']);
    assert.strictEqual(runtime.turns.size, 0);
  });

  it('skips a case whose owner is mid-turn, then runs it after endTurn', async () => {
    const { runtime, clock, calls } = harness({ orient: '{"changed": false, "why": "nothing new"}' });
    const c = await activeCase(runtime);
    dueWakeup(runtime, c, clock);
    const owner = await runtime.beginTurn(c.id, { turnId: 'turn-owner' });
    const wakeFile = path.join(c.dir, '.kl', 'wakeups.json');
    const before = { wakeups: fs.readFileSync(wakeFile, 'utf8'), commits: (await git.git(c.dir, ['rev-list', '--count', 'HEAD'])).trim() };
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, busy: 1 });
    assert.strictEqual(calls.orient, 0);
    assert.strictEqual(fs.readFileSync(wakeFile, 'utf8'), before.wakeups);
    assert.strictEqual((await git.git(c.dir, ['rev-list', '--count', 'HEAD'])).trim(), before.commits);
    await runtime.endTurn(owner, {});
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, quiet: 1 });
    assert.strictEqual(calls.orient, 1);
  });

  it('orient provider down: failed, backoff, one briefing on the third failure, no judge call', async () => {
    const down = Object.assign(new Error('503 Service Unavailable'), { status: 503 });
    const { runtime, clock, calls } = harness({ orient: down });
    const c = await activeCase(runtime);
    const id = dueWakeup(runtime, c, clock);
    const failing = () => runtime.questions(c.id).open().filter((q) => q.payload.type === 'wakeups-failing');
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, failed: 1 });
    let w = runtime.wakeups(c.id).list().find((x) => x.id === id);
    assert.deepStrictEqual([w.attempts, w.nextAt], [1, new Date(clock.now.getTime() + 5 * MIN).toISOString()]);
    assert.deepStrictEqual(failing(), []);
    for (const minutes of [5, 15]) {
      advance(clock, minutes * MIN);
      assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, failed: 1 });
    }
    w = runtime.wakeups(c.id).list().find((x) => x.id === id);
    assert.strictEqual(w.attempts, 3);
    assert.strictEqual(failing().length, 1);
    assert.strictEqual(failing()[0].urgency, 'normal');
    advance(clock, 60 * MIN);
    await runtime.runDueWakeups(clock.now);
    assert.strictEqual(failing().length, 1, 'deduplicated while open');
    assert.strictEqual(calls.judge, 0);
    const entries = wakeupJournals(c);
    assert.strictEqual(entries.length, 4);
    assert.ok(entries.every((e) => e.startsWith('failed: 503 Service Unavailable')));
  });

  it('in needs-direction only poll-executor and deadline-check run; polling needs a material change (C3 stub)', async () => {
    let polls = 0;
    const registry = { pollWakeup: async () => { polls += 1; return { material: polls > 1 }; }, cancelOpenJobs: () => {} };
    const { runtime, clock, calls } = harness({ host: { getExecutorRegistry: () => registry } });
    const c = await activeCase(runtime);
    runtime.setStatus(c.id, 'needs-direction', { kind: 'failure', ref: 'journal/x-failure.md', failureClass: 'dead-end' });
    const poll = runtime.wakeups(c.id).register({ kind: 'poll-executor', every: 5 * MIN, payload: { key: 'phone-agent' } });
    const retry = dueWakeup(runtime, c, clock);
    advance(clock, 5 * MIN);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, quiet: 1 });
    assert.strictEqual(calls.orient, 0);
    advance(clock, 5 * MIN);
    assert.deepStrictEqual(await runtime.runDueWakeups(clock.now), { ...zero, ran: 1 });
    assert.strictEqual(polls, 2);
    const left = runtime.wakeups(c.id).list().map((w) => w.id);
    assert.ok(left.includes(retry), 'the retry waits for direction');
    assert.ok(left.includes(poll));
  });

  it('cancels every wake-up of an abandoned case, and does nothing when wake-ups are off', async () => {
    const { runtime, clock } = harness();
    const c = await activeCase(runtime);
    dueWakeup(runtime, c, clock);
    runtime.store.updateMeta(c.id, { status: 'abandoned' });
    await runtime.runDueWakeups(clock.now);
    assert.deepStrictEqual(runtime.wakeups(c.id).list(), []);

    const off = harness({ settings: { wakeups: { enabled: false } } });
    const d = await activeCase(off.runtime);
    dueWakeup(off.runtime, d, off.clock);
    assert.deepStrictEqual(await off.runtime.runDueWakeups(off.clock.now), zero);
    assert.strictEqual(off.calls.orient, 0);
  });
});
