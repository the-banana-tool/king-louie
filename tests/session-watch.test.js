'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { startSessionWatch } = require('../src/session/session-watch');

function fakeTimers() {
  const live = new Map();
  let nextId = 1;
  return {
    live,
    timers: {
      setInterval: (fn, ms) => { const id = nextId++; live.set(id, { fn, ms }); return id; },
      clearInterval: (id) => { live.delete(id); }
    },
    async tick() {
      for (const { fn } of [...live.values()]) await fn();
    }
  };
}

const quietLog = { warn: () => {}, info: () => {}, error: () => {} };
const recorder = Object.freeze({ ffmpeg: 'C:\\f\\ffmpeg.exe' });

function baseReport(over = {}) {
  return { capabilities: ['screenshot'], probes: [], displays: [], limits: [], locked: false, recorder, ...over };
}

describe('startSessionWatch', () => {
  it('emits probe_changed only when capabilities or limits change, and carries recorder', async () => {
    const t = fakeTimers();
    const next = { capabilities: ['screenshot', 'input'], probes: [], displays: [{ id: 1 }], limits: [], locked: false };
    let probeResult = { capabilities: ['screenshot'], probes: [], displays: [{ id: 2 }], limits: [], locked: false };
    const backend = { probe: async () => probeResult };
    const calls = [];
    const watch = startSessionWatch(backend, { report: baseReport(), recorder, log: quietLog, emit: (k, p) => calls.push([k, p]), timers: t.timers });
    await t.tick();
    assert.deepEqual(calls, [], 'a change in displays alone is not a probe change');
    probeResult = next;
    await t.tick();
    assert.deepEqual(calls, [['probe_changed', { ...next, recorder: { ffmpeg: 'C:\\f\\ffmpeg.exe' } }]]);
    assert.deepEqual(watch.current(), { ...next, recorder });
    await t.tick();
    assert.equal(calls.length, 1, 'the same report again emits nothing');
    probeResult = { ...next, limits: ['no_input'] };
    await t.tick();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1][1].limits, ['no_input']);
    watch.stop();
  });

  it('emits locked then unlocked on a change, nothing on null or no change', async () => {
    const t = fakeTimers();
    const answers = [false, true, true, null, false, false];
    let i = 0;
    const backend = { probe: async () => baseReport(), locked: async () => answers[i++] };
    const calls = [];
    const watch = startSessionWatch(backend, { report: baseReport(), recorder, log: quietLog, emit: (k, p) => calls.push([k, p]), timers: t.timers, reprobeMs: 60000, lockPollMs: 2000 });
    const lockFn = [...t.live.values()].find((x) => x.ms === 2000).fn;
    for (let n = 0; n < answers.length; n += 1) await lockFn();
    assert.deepEqual(calls, [['locked', {}], ['unlocked', {}]]);
    watch.stop();
  });

  it('a lock query that throws emits nothing', async () => {
    const t = fakeTimers();
    const backend = { probe: async () => baseReport(), locked: async () => { throw new Error('no'); } };
    const calls = [];
    const watch = startSessionWatch(backend, { report: baseReport(), recorder, log: quietLog, emit: (k, p) => calls.push([k, p]), timers: t.timers });
    await t.tick();
    assert.deepEqual(calls, []);
    watch.stop();
  });

  it('a backend without locked() emits nothing from the lock poll', async () => {
    const t = fakeTimers();
    const backend = { probe: async () => baseReport() };
    const calls = [];
    const watch = startSessionWatch(backend, { report: baseReport(), recorder, log: quietLog, emit: (k, p) => calls.push([k, p]), timers: t.timers });
    await t.tick();
    await t.tick();
    assert.deepEqual(calls, []);
    watch.stop();
  });

  it('a null backend emits nothing', async () => {
    const t = fakeTimers();
    const calls = [];
    const report = baseReport({ capabilities: [] });
    const watch = startSessionWatch(null, { report, recorder, log: quietLog, emit: (k, p) => calls.push([k, p]), timers: t.timers });
    await t.tick();
    assert.deepEqual(calls, []);
    assert.equal(watch.current(), report);
    watch.stop();
  });

  it('stop() clears both intervals', () => {
    const t = fakeTimers();
    const backend = { probe: async () => baseReport(), locked: async () => false };
    const watch = startSessionWatch(backend, { report: baseReport(), recorder, log: quietLog, emit: () => {}, timers: t.timers, reprobeMs: 50, lockPollMs: 10 });
    assert.deepEqual([...t.live.values()].map((x) => x.ms).sort((a, b) => a - b), [10, 50]);
    watch.stop();
    assert.equal(t.live.size, 0);
  });

  it('a callback in flight when stop() is called emits nothing after it', async () => {
    const t = fakeTimers();
    let releaseProbe;
    let releaseLock;
    const backend = {
      probe: () => new Promise((r) => { releaseProbe = r; }),
      locked: () => new Promise((r) => { releaseLock = r; })
    };
    const calls = [];
    const watch = startSessionWatch(backend, { report: baseReport(), recorder, log: quietLog, emit: (k, p) => calls.push([k, p]), timers: t.timers });
    const fns = [...t.live.values()].map((x) => x.fn);
    const running = fns.map((fn) => fn());
    watch.stop();
    releaseProbe({ capabilities: ['screenshot', 'input'], probes: [], displays: [], limits: [], locked: false });
    releaseLock(true);
    await Promise.all(running);
    assert.deepEqual(calls, []);
  });
});
