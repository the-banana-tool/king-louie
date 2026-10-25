'use strict';

// Take.run_steps' runner (spec docs/superpowers/specs/2026-10-24-agent-driven-demo-takes-design.md §10).

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateSteps, runSteps, STEP_KINDS } = require('../src/gui/take-steps');

const cleanups = [];
after(() => { for (const c of cleanups.reverse()) c(); });

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-take-steps-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeClock() {
  return { t: 1000, now() { return this.t; } };
}

// Manual timers on the fake clock: nothing fires until advance().
function fakeTimers(clock) {
  let list = [];
  return {
    setTimeout(fn, ms) { const t = { fn, ms, at: clock.t + ms }; list.push(t); return t; },
    clearTimeout(t) { list = list.filter((x) => x !== t); },
    advance(ms) {
      clock.t += ms;
      for (;;) {
        const due = list.filter((x) => x.at <= clock.t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        list = list.filter((x) => x !== due);
        due.fn();
      }
    },
    pending: () => list.map((x) => x.ms)
  };
}

// Browser actions that record what they were called with; `fail` names actions (or call
// numbers) that reject. The page URL moves on navigate.
function fakeActions({ shotDir, fail = {} } = {}) {
  const a = {
    calls: [],
    url: 'https://app.example.com/',
    n: 0
  };
  const act = (name) => async (params, ctx) => {
    a.n += 1;
    a.calls.push({ name, params, ctx });
    const f = fail[name];
    if (f === 'hang') return new Promise(() => {});
    if (f === 'soft') return { ok: false, error: `${name} said no` };
    if (f) throw new Error(`${name} failed\n  call log: waiting for locator`);
    if (name === 'navigate') a.url = params.url;
    return { ok: true };
  };
  for (const name of ['navigate', 'click', 'dblclick', 'hover', 'focus', 'check', 'uncheck', 'clear', 'fill', 'type',
    'press', 'select_option', 'scroll', 'wait_for', 'wait_for_url']) a[name] = act(name);
  a.status = async () => ({ ok: true, running: true, currentUrl: a.url });
  a.screenshot = async (params, ctx) => {
    a.calls.push({ name: 'screenshot', params, ctx });
    if (fail.screenshot) throw new Error('screenshot failed');
    const p = path.join(shotDir, `screenshot-${a.calls.length}.png`);
    fs.writeFileSync(p, 'png');
    return { ok: true, savedTo: p };
  };
  return a;
}

function fakePolicy(refuse = () => null) {
  const p = {
    calls: [],
    async decide(toolName, params) {
      p.calls.push({ toolName, params });
      return refuse(params) || { allow: true };
    }
  };
  return p;
}

function setup({ fail, refuse } = {}) {
  const clock = fakeClock();
  const timers = fakeTimers(clock);
  const shotDir = tempDir();
  const takeDir = path.join(tempDir(), 'take-1');
  const actions = fakeActions({ shotDir, fail });
  const policy = fakePolicy(refuse);
  const context = { takePolicy: { current: { browserKey: 'take:take-1' } } };
  const deps = { actions, context, policy, takeDir, clock: () => clock.now(), timers };
  return { clock, timers, actions, policy, context, takeDir, deps };
}

const browserCalls = (actions) => actions.calls.map((c) => c.name);

describe('validateSteps', () => {
  it('validateSteps: 201 steps, an unknown step, a 2 minute pause, pauses over 60 s, timeout over 120 s are refused', () => {
    const click = { step: 'click', selector: '#go' };
    const tooMany = validateSteps(Array.from({ length: 201 }, () => click));
    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.error.code, 'invalid_params');
    assert.match(tooMany.error.message, /200/);

    const unknown = validateSteps([click, { step: 'evaluate<script>', selector: 'x' }]);
    assert.equal(unknown.ok, false);
    assert.match(unknown.error.message, /^step 1: /);
    assert.ok(!unknown.error.message.includes('evaluate'), 'a model string is not echoed');

    const longPause = validateSteps([{ step: 'pause', ms: 120000 }]);
    assert.equal(longPause.ok, false);
    assert.match(longPause.error.message, /^step 0 \(pause\): "ms"/);

    const pauses = Array.from({ length: 7 }, () => ({ step: 'pause', ms: 9000 }));
    const total = validateSteps(pauses);
    assert.equal(total.ok, false);
    assert.match(total.error.message, /60/);
    assert.equal(validateSteps(pauses.slice(0, 6)).ok, true);

    const slow = validateSteps([{ step: 'wait_for', selector: '#a', state: 'visible', timeout_ms: 120001 }]);
    assert.equal(slow.ok, false);
    assert.equal(validateSteps([{ step: 'wait_for', selector: '#a', state: 'visible', timeout_ms: 120000 }]).ok, true);
  });

  it('every step takes exactly its fields', () => {
    const good = [
      { step: 'navigate', url: 'https://app.example.com/' },
      { step: 'click', selector: '#a' }, { step: 'dblclick', selector: '#a' }, { step: 'hover', selector: '#a' },
      { step: 'focus', selector: '#a' }, { step: 'check', selector: '#a' }, { step: 'uncheck', selector: '#a' },
      { step: 'clear', selector: '#a' },
      { step: 'fill', selector: '#a', text: 'hello' }, { step: 'type', selector: '#a', text: 'hello' },
      { step: 'press', key: 'Enter' }, { step: 'press', key: 'Enter', selector: '#a' },
      { step: 'select_option', selector: '#a', value: 'b' },
      { step: 'scroll', dx: 0, dy: 400 }, { step: 'scroll', selector: '#a', dx: 0, dy: 0 },
      { step: 'wait_for', selector: '#a', state: 'hidden' }, { step: 'wait_for_url', url: '**/done' },
      { step: 'wait_for_text', selector: '#a', text: 'Ready', timeout_ms: 60000 },
      { step: 'pause', ms: 500 }, { step: 'screenshot' }, { step: 'screenshot', name: 'hero' },
      { step: 'note', text: 'The answer appears here' }
    ];
    assert.equal(validateSteps(good).ok, true);
    assert.deepEqual([...new Set(good.map((s) => s.step))].sort(), [...STEP_KINDS].sort());
    const bad = [
      { step: 'click' },
      { step: 'click', selector: '#a', text: 'x' },
      { step: 'navigate' },
      { step: 'fill', selector: '#a' },
      { step: 'press', selector: '#a' },
      { step: 'scroll', dx: 1 },
      { step: 'scroll', dx: 1.5, dy: 2 },
      { step: 'wait_for', selector: '#a', state: 'gone' },
      { step: 'wait_for_url', url: 'x', timeout_ms: 0 },
      { step: 'pause', ms: 10001 },
      { step: 'screenshot', name: '../../evil' },
      { step: 'note', text: 'two\nlines' },
      { step: 'note', text: '' },
      'click',
      null
    ];
    for (const s of bad) {
      const r = validateSteps([s]);
      assert.equal(r.ok, false, JSON.stringify(s));
      assert.match(r.error.message, /^step 0/);
      assert.ok(!r.error.message.includes('\n'));
    }
  });

  it('the list is 1..200 steps of at most 64 KiB, and from is an index in it', () => {
    assert.equal(validateSteps([]).ok, false);
    assert.equal(validateSteps('steps').ok, false);
    const big = validateSteps([{ step: 'fill', selector: '#a', text: 'x'.repeat(8000) },
      ...Array.from({ length: 9 }, () => ({ step: 'fill', selector: '#a', text: 'x'.repeat(8000) }))]);
    assert.equal(big.ok, false);
    assert.match(big.error.message, /64 KiB/);
    const two = [{ step: 'click', selector: '#a' }, { step: 'click', selector: '#b' }];
    assert.equal(validateSteps(two, { from: 1 }).ok, true);
    assert.equal(validateSteps(two, { from: 2 }).ok, false);
    assert.equal(validateSteps(two, { from: -1 }).ok, false);
    assert.equal(validateSteps(two, { from: 0.5 }).ok, false);
  });
});

describe('runSteps', () => {
  const script = [
    { step: 'navigate', url: 'https://app.example.com/start' },
    { step: 'fill', selector: '#q', text: 'hello' },
    { step: 'click', selector: '#go' },
    { step: 'click', selector: '#next' }
  ];

  it('runs in order and stops at the first failure with a screenshot', async () => {
    const s = setup({ fail: { click: true } });
    const out = await runSteps({ steps: script }, s.deps);
    assert.equal(out.results.length, 3);
    assert.equal(out.stopped_at, 2);
    assert.deepEqual(out.results.map((r) => r.index), [0, 1, 2]);
    assert.deepEqual(out.results.map((r) => r.ok), [true, true, false]);
    assert.deepEqual(browserCalls(s.actions), ['navigate', 'fill', 'click', 'screenshot']);
    assert.deepEqual(s.actions.calls[0].params, { url: 'https://app.example.com/start' });
    assert.deepEqual(s.actions.calls[1].params, { selector: '#q', text: 'hello' });
    assert.equal(s.actions.calls[0].ctx, s.context, 'the context as passed resolves the take\'s browser');
    const failed = out.results[2];
    assert.equal(failed.step, 'click');
    assert.equal(failed.action, 'click');
    assert.equal(failed.error.code, 'step_failed');
    assert.equal(failed.error.message, 'click failed', 'one line of the error');
    assert.ok(failed.screenshot.endsWith('step-2-failed.png'));
    assert.equal(path.dirname(failed.screenshot), s.takeDir);
    assert.ok(fs.existsSync(failed.screenshot));
    assert.equal(out.results[0].url, 'https://app.example.com/start');
    // The policy saw every step as the browser call it makes, and the capture too.
    assert.deepEqual(s.policy.calls.map((c) => c.params.action), ['navigate', 'fill', 'click', 'screenshot']);
    assert.ok(s.policy.calls.every((c) => c.toolName === 'Browser'));
    assert.deepEqual(s.policy.calls[1].params, { action: 'fill', selector: '#q', text: 'hello' });
  });

  it('a soft failure ({ ok: false }) is a failure, and a failed capture never masks it', async () => {
    const s = setup({ fail: { fill: 'soft', screenshot: true } });
    const out = await runSteps({ steps: script }, s.deps);
    assert.equal(out.stopped_at, 1);
    assert.deepEqual(out.results[1].error, { code: 'step_failed', message: 'fill said no' });
    assert.equal(out.results[1].screenshot, undefined);
  });

  it('continue_on_error runs the rest', async () => {
    const s = setup({ fail: { fill: true } });
    const out = await runSteps({ steps: script, continueOnError: true }, s.deps);
    assert.equal(out.stopped_at, null);
    assert.deepEqual(out.results.map((r) => r.ok), [true, false, true, true]);
    assert.deepEqual(browserCalls(s.actions), ['navigate', 'fill', 'screenshot', 'click', 'click']);
  });

  it('from resumes at the index', async () => {
    const s = setup();
    const out = await runSteps({ steps: script, from: 2 }, s.deps);
    assert.deepEqual(out.results.map((r) => r.index), [2, 3]);
    assert.deepEqual(browserCalls(s.actions), ['click', 'click']);
    assert.deepEqual(s.actions.calls.map((c) => c.params.selector), ['#go', '#next']);
    assert.equal(out.stopped_at, null);
  });

  it('a policy refusal is the step error with its code', async () => {
    const s = setup({ refuse: (p) => (p.action === 'navigate' ? { allow: false, code: 'take_site_not_allowed', error: 'evil.test is not one of this take\'s sites' } : null) });
    const out = await runSteps({ steps: [{ step: 'navigate', url: 'https://evil.test/' }, { step: 'click', selector: '#a' }] }, s.deps);
    assert.equal(out.stopped_at, 0);
    assert.equal(out.results.length, 1);
    assert.deepEqual(out.results[0].error, { code: 'take_site_not_allowed', message: 'evil.test is not one of this take\'s sites' });
    assert.ok(!browserCalls(s.actions).includes('navigate'), 'the browser is never asked');
  });

  it('a refusal thrown by the policy carries its code too', async () => {
    const s = setup();
    s.deps.policy = { async decide() { const e = new Error('no'); e.code = 'take_action_not_allowed'; throw e; } };
    const out = await runSteps({ steps: [{ step: 'click', selector: '#a' }] }, s.deps);
    assert.equal(out.results[0].error.code, 'take_action_not_allowed');
    assert.deepEqual(browserCalls(s.actions), []);
  });

  it('wait_for_text builds a text locator and passes the timeout', async () => {
    const s = setup();
    await runSteps({ steps: [
      { step: 'wait_for_text', selector: '.answer', text: 'Done', timeout_ms: 90000 },
      { step: 'wait_for', selector: '#a', state: 'attached' },
      { step: 'wait_for_url', url: '**/done', timeout_ms: 45000 }
    ] }, s.deps);
    assert.deepEqual(s.actions.calls.map((c) => [c.name, c.params]), [
      ['wait_for', { selector: '.answer >> text=Done', state: 'visible', timeout: 90000 }],
      ['wait_for', { selector: '#a', state: 'attached', timeout: 30000 }],
      ['wait_for_url', { url: '**/done', timeout: 45000 }]
    ]);
  });

  it('the other steps map onto their browser actions', async () => {
    const s = setup();
    await runSteps({ steps: [
      { step: 'press', key: 'Enter' },
      { step: 'press', key: 'Tab', selector: '#a' },
      { step: 'select_option', selector: '#s', value: 'b' },
      { step: 'scroll', dx: 0, dy: 300 },
      { step: 'type', selector: '#t', text: 'hi' }
    ] }, s.deps);
    assert.deepEqual(s.actions.calls.map((c) => [c.name, c.params]), [
      ['press', { key: 'Enter' }],
      ['press', { key: 'Tab', selector: '#a' }],
      ['select_option', { selector: '#s', value: 'b' }],
      ['scroll', { delta_x: 0, delta_y: 300 }],
      ['type', { selector: '#t', text: 'hi' }]
    ]);
  });

  it('note goes to results, not to the browser', async () => {
    const s = setup();
    const notes = [];
    const out = await runSteps({ steps: [{ step: 'note', text: 'Now the answer' }] }, { ...s.deps, onNote: (t) => notes.push(t) });
    assert.deepEqual(browserCalls(s.actions), []);
    assert.deepEqual(s.policy.calls, []);
    assert.equal(out.results[0].ok, true);
    assert.equal(out.results[0].note, 'Now the answer');
    assert.deepEqual(notes, ['Now the answer']);
  });

  it('a screenshot step lands in the take directory under its name', async () => {
    const s = setup();
    const out = await runSteps({ steps: [{ step: 'screenshot', name: 'hero' }, { step: 'screenshot' }] }, s.deps);
    assert.equal(out.results[0].screenshot, path.join(s.takeDir, 'hero.png'));
    assert.equal(out.results[1].screenshot, path.join(s.takeDir, 'step-1.png'));
    assert.ok(fs.existsSync(out.results[0].screenshot));
    assert.deepEqual(s.actions.calls[0].params, {});
  });

  it('pause waits on a ref\'d timer, and ms comes from the clock', async () => {
    const s = setup();
    const p = runSteps({ steps: [{ step: 'pause', ms: 2500 }] }, s.deps);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(s.timers.pending(), [2500]);
    s.timers.advance(2500);
    const out = await p;
    assert.equal(out.results[0].ok, true);
    assert.equal(out.results[0].ms, 2500);
    assert.equal(out.results[0].url, 'https://app.example.com/');
  });

  it('a step that hangs past its timeout is that step\'s failure', async () => {
    const s = setup({ fail: { wait_for: 'hang' } });
    const p = runSteps({ steps: [{ step: 'wait_for', selector: '#a', state: 'visible', timeout_ms: 1000 }, { step: 'click', selector: '#b' }] }, s.deps);
    await new Promise((r) => setImmediate(r));
    s.timers.advance(60000);
    const out = await p;
    assert.equal(out.stopped_at, 0);
    assert.equal(out.results[0].error.code, 'op_timeout');
    assert.ok(!browserCalls(s.actions).includes('click'));
  });

  it('a take that ends mid-run stops it', async () => {
    const s = setup();
    let live = true;
    s.actions.fill = async () => { live = false; return { ok: true }; };
    const out = await runSteps({ steps: script }, { ...s.deps, isLive: () => live });
    assert.equal(out.stopped_at, 2);
    assert.equal(out.results[2].error.code, 'lease_required');
    assert.deepEqual(browserCalls(s.actions), ['navigate']);
  });
});

describe('Take.run_steps', () => {
  const { buildTakeTool } = require('../src/gui/take-tool');
  const tool = (config, run) => ({ ...config, execute: (params, options) => run(params, options) });

  function fakeTakes({ recording = null, stopWhenDone = false, steps = [] } = {}) {
    const clock = fakeClock();
    const policy = fakePolicy();
    const t = {
      record: { take_id: 'take-1', job_id: 'job-1', recording, steps },
      live: true, notes: [], stops: [], policy,
      store: { dir: tempDir() },
      clock: () => clock.now(),
      timers: fakeTimers(clock),
      forJob: (jobId) => (jobId === 'job-1' ? t.record : null),
      context: (id) => (t.live && id === 'take-1' ? { takeId: id, jobId: 'job-1', browser: {}, policy, stopWhenDone } : null),
      recordSteps: (id, list) => { t.record = { ...t.record, steps: list }; },
      note: (id, text) => { t.notes.push(text); },
      stop: async (id, opts) => { t.stops.push(opts); t.live = false; return { recording: null, steps: { done: 1, failed: 0, total: 1 }, ended: 'take_done' }; }
    };
    return t;
  }

  function build(takes, fail) {
    const actions = fakeActions({ shotDir: tempDir(), fail });
    const Take = buildTakeTool({ takes, tool, jobIdOf: () => 'job-1', browserActions: () => actions });
    return { Take, actions };
  }

  const three = () => [
    { step: 'note', text: 'Open the app' },
    { step: 'navigate', url: 'https://app.example.com/' },
    { step: 'click', selector: '#go' }
  ];

  it('runs on the take\'s browser and policy, keeps the results on the record and puts captures under the store, not beside the recording', async () => {
    const recDir = tempDir();
    const takes = fakeTakes({ recording: { path: path.join(recDir, 'take-1.mp4') } });
    const { Take, actions } = build(takes, { click: true });
    const options = { takePolicy: { current: { browserKey: 'take:take-1' } } };
    const out = await Take.execute({ action: 'run_steps', steps: three() }, options);
    assert.equal(out.ok, true);
    assert.equal(out.untrusted_output, true);
    assert.equal(out.stopped_at, 2);
    const takeDir = path.join(takes.store.dir, 'take-1');
    assert.equal(out.take_dir, takeDir);
    assert.equal(out.results[2].screenshot, path.join(takeDir, 'step-2-failed.png'));
    assert.ok(fs.existsSync(out.results[2].screenshot));
    assert.deepEqual(fs.readdirSync(recDir), [], 'nothing is written beside the recording');
    assert.ok(actions.calls.every((c) => c.ctx === options));
    assert.deepEqual(takes.policy.calls.map((c) => c.params.action), ['navigate', 'click', 'screenshot']);
    assert.deepEqual(takes.notes, ['Open the app']);
    assert.deepEqual(takes.record.steps.map((s) => [s.index, s.action, s.ok]), [[0, 'note', true], [1, 'navigate', true], [2, 'click', false]]);
    // Resumed from the failed index: the steps before it keep their outcome, the rest are replaced.
    actions.click = async () => ({ ok: true });
    const again = await Take.execute({ action: 'run_steps', from: 2, steps: three() }, options);
    assert.equal(again.stopped_at, null);
    assert.deepEqual(takes.record.steps.map((s) => [s.index, s.ok]), [[0, true], [1, true], [2, true]]);
    assert.equal(again.stopped, undefined);
  });

  it('a take with no recording keeps its stills in its own folder', async () => {
    const takes = fakeTakes();
    const { Take } = build(takes);
    const out = await Take.execute({ action: 'run_steps', steps: [{ step: 'screenshot', name: 'hero' }] }, {});
    assert.equal(out.results[0].screenshot, path.join(takes.store.dir, 'take-1', 'hero.png'));
    assert.equal(out.take_dir, path.join(takes.store.dir, 'take-1'));
    assert.ok(fs.statSync(out.take_dir).isDirectory(), 'made on first use');
  });

  it('stop_when_done stops the take when the last step passes, and not after a failure', async () => {
    const done = fakeTakes({ stopWhenDone: true });
    const out = await build(done).Take.execute({ action: 'run_steps', steps: [{ step: 'click', selector: '#a' }] }, {});
    assert.equal(out.stopped.ended, 'take_done');
    assert.equal(done.stops.length, 1);
    const failing = fakeTakes({ stopWhenDone: true });
    const bad = await build(failing, { click: true }).Take.execute({
      action: 'run_steps', continue_on_error: true, steps: [{ step: 'click', selector: '#a' }, { step: 'hover', selector: '#b' }]
    }, {});
    assert.equal(bad.stopped, undefined);
    assert.equal(failing.stops.length, 0);
  });

  it('bad steps, a take that has ended and no take are refused before the browser', async () => {
    const takes = fakeTakes();
    const { Take, actions } = build(takes);
    const bad = await Take.execute({ action: 'run_steps', steps: [{ step: 'pause', ms: 20000 }] }, {});
    assert.equal(bad.code, 'invalid_params');
    assert.match(bad.error, /^invalid_params: step 0 \(pause\)/);
    takes.live = false;
    const ended = await Take.execute({ action: 'run_steps', steps: [{ step: 'click', selector: '#a' }] }, {});
    assert.equal(ended.code, 'invalid_params');
    assert.match(ended.error, /ended/);
    takes.record = null;
    const none = await Take.execute({ action: 'run_steps', steps: [{ step: 'click', selector: '#a' }] }, {});
    assert.match(none.error, /no take/);
    assert.deepEqual(actions.calls, []);
  });
});
