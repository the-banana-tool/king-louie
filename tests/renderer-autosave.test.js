'use strict';

// Auto-save for individual settings (settings redesign Task 12, spec 5.8 rule 1, 7.1).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAutosave } = require('../renderer-helpers/autosave');

function fakeTimers() {
  let next = 1;
  const timers = new Map();
  return {
    setTimer(fn, ms) { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimer(id) { timers.delete(id); },
    pending() { return [...timers.values()]; },
    fire() {
      const all = [...timers.entries()];
      timers.clear();
      for (const [, t] of all) t.fn();
    }
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

function harness(saveImpl) {
  const timers = fakeTimers();
  const saved = [];
  const states = [];
  const saver = createAutosave({
    save: saveImpl || (async (v) => { saved.push(v); return { ok: true }; }),
    delayMs: 600,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onState: (state, info) => states.push({ state, ...info })
  });
  return { timers, saved, states, saver };
}

describe('createAutosave', () => {
  it('saves a burst of changes once, with the last value, after delayMs', async () => {
    const { timers, saved, states, saver } = harness();
    saver.change('a');
    saver.change('ab');
    saver.change('abc');
    assert.equal(saved.length, 0);
    assert.equal(timers.pending().length, 1);
    assert.equal(timers.pending()[0].ms, 600);
    timers.fire();
    await tick();
    assert.deepEqual(saved, ['abc']);
    assert.deepEqual(states.map((s) => s.state), ['saving', 'saved']);
    assert.equal(states[1].value, 'abc');
  });

  it('saves an immediate change without waiting', async () => {
    const { timers, saved, saver } = harness();
    saver.change(true, { immediate: true });
    assert.deepEqual(saved, [true]);
    assert.equal(timers.pending().length, 0);
  });

  it('flush() sends a pending value at once and resolves when it is saved', async () => {
    const { timers, saved, states, saver } = harness();
    saver.change('half typed');
    const done = saver.flush();
    assert.deepEqual(saved, ['half typed'], 'the save is sent synchronously');
    assert.equal(timers.pending().length, 0);
    await done;
    assert.equal(states.at(-1).state, 'saved');
  });

  it('flush() with nothing pending resolves without saving', async () => {
    const { saved, saver } = harness();
    await saver.flush();
    assert.deepEqual(saved, []);
  });

  it('a failing save reports error with its message', async () => {
    const { states, saver } = harness(async () => ({ ok: false, error: 'node unreachable' }));
    saver.change(5, { immediate: true });
    await saver.flush();
    assert.deepEqual(states.at(-1), { state: 'error', error: 'node unreachable', value: 5, saved: undefined });
  });

  it('a save that throws counts as { ok: false, error: err.message }', async () => {
    const { states, saver } = harness(async () => { throw new Error('bridge closed'); });
    saver.change('x', { immediate: true });
    await saver.flush();
    assert.equal(states.at(-1).state, 'error');
    assert.equal(states.at(-1).error, 'bridge closed');
  });

  it('a save that throws synchronously is still an error, not a crash', async () => {
    const { states, saver } = harness(() => { throw new Error('sync'); });
    saver.change('x', { immediate: true });
    await saver.flush();
    assert.equal(states.at(-1).error, 'sync');
  });

  it('reports the last value that saved, so the caller can put the field back', async () => {
    let fail = false;
    const { states, saver } = harness(async () => (fail ? { ok: false, error: 'no' } : { ok: true }));
    saver.change('good', { immediate: true });
    await saver.flush();
    fail = true;
    saver.change('bad', { immediate: true });
    await saver.flush();
    assert.deepEqual(states.at(-1), { state: 'error', error: 'no', value: 'bad', saved: 'good' });
  });

  it('a change while a save is in flight is not lost and waits for that save', async () => {
    const calls = [];
    const gates = [];
    const { states, saver } = harness((v) => {
      calls.push(v);
      const d = deferred();
      gates.push(d);
      return d.promise;
    });
    saver.change('one', { immediate: true });
    saver.change('two', { immediate: true });
    saver.change('three', { immediate: true });
    assert.deepEqual(calls, ['one'], 'saves never overlap');
    gates[0].resolve({ ok: true });
    await tick();
    assert.deepEqual(calls, ['one', 'three'], 'only the newest waiting value is sent');
    assert.ok(!states.some((s) => s.state === 'saved' && s.value === 'one'),
      'an older save never reports saved once a newer value exists');
    gates[1].resolve({ ok: true });
    await saver.flush();
    assert.deepEqual(states.filter((s) => s.state !== 'saving'), [{ state: 'saved', value: 'three', saved: 'three' }]);
  });

  it('an older save failing while a newer value waits reports nothing, so the newer typing is kept', async () => {
    const gates = [];
    const { states, saver } = harness(() => { const d = deferred(); gates.push(d); return d.promise; });
    saver.change('old', { immediate: true });
    saver.change('new');
    gates[0].resolve({ ok: false, error: 'dropped' });
    await tick();
    assert.ok(!states.some((s) => s.state === 'error'), 'no error restores the field over the newer value');
    const done = saver.flush();
    gates[1].resolve({ ok: true });
    await done;
    assert.equal(states.at(-1).state, 'saved');
    assert.equal(states.at(-1).value, 'new');
  });

  it('a debounced change during a save still waits for its own timer', async () => {
    const gates = [];
    const calls = [];
    const { timers, saver } = harness((v) => { calls.push(v); const d = deferred(); gates.push(d); return d.promise; });
    saver.change('a', { immediate: true });
    saver.change('ab');
    gates[0].resolve({ ok: true });
    await tick();
    assert.deepEqual(calls, ['a']);
    timers.fire();
    assert.deepEqual(calls, ['a', 'ab']);
  });

  it('flush() during a save waits for it and then sends the pending value', async () => {
    const gates = [];
    const calls = [];
    const { saver } = harness((v) => { calls.push(v); const d = deferred(); gates.push(d); return d.promise; });
    saver.change('a', { immediate: true });
    saver.change('ab');
    let flushed = false;
    const done = saver.flush().then(() => { flushed = true; });
    gates[0].resolve({ ok: true });
    await tick();
    assert.deepEqual(calls, ['a', 'ab']);
    assert.equal(flushed, false);
    gates[1].resolve({ ok: true });
    await done;
    assert.equal(flushed, true);
  });

  it('an onState that throws does not stop later saves', async () => {
    const saved = [];
    const saver = createAutosave({
      save: async (v) => { saved.push(v); return { ok: true }; },
      onState: () => { throw new Error('paint failed'); }
    });
    saver.change(1, { immediate: true });
    await saver.flush();
    saver.change(2, { immediate: true });
    await saver.flush();
    assert.deepEqual(saved, [1, 2]);
  });
});

describe('renderer wiring', () => {
  const root = path.join(__dirname, '..');
  const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const block = (head) => {
    const start = renderer.indexOf(head);
    assert.ok(start >= 0, `${head} is in renderer.js`);
    return renderer.slice(start, renderer.indexOf('\n}\n', start));
  };

  it('loads the helpers before renderer.js', () => {
    const at = (src) => html.indexOf(`<script src="${src}"></script>`);
    assert.ok(at('renderer-helpers/autosave.js') > 0);
    assert.ok(at('renderer-helpers/units.js') > 0);
    assert.ok(at('renderer-helpers/autosave.js') < at('renderer.js'));
    assert.ok(at('renderer-helpers/units.js') < at('renderer.js'));
  });

  it('flushSettingsAutosaves flushes every registered saver', () => {
    const body = block('function flushSettingsAutosaves(');
    assert.match(body, /settingsAutosaves/);
    assert.match(body, /\.flush\(\)/);
  });

  it('showSaveState paints #settings-save-state by textContent with the fixed copy', () => {
    const body = block('function showSaveState(');
    assert.match(body, /settings-save-state/);
    assert.match(body, /textContent/);
    assert.doesNotMatch(body, /innerHTML/);
    assert.match(body, /'Saved'/);
    assert.match(body, /'Saving…'/);
  });
});
