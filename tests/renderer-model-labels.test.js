const { describe, it } = require('node:test');
const assert = require('node:assert');
const { providerDisplayName, isFree, modelChip, roleStatus } = require('../renderer-helpers/model-labels');

const ok = { provider: 'a', model: 'm' };
const bad = { provider: 'a', model: 'n', usable: false };
const eye = { provider: 'a', model: 'v', imageInput: true };

describe('providerDisplayName', () => {
  it('names a local server, or falls back to its id', () => {
    assert.strictEqual(providerDisplayName('local', {}, { ws: 'Workstation' }, 'ws/qwen3:8b'), 'Workstation');
    assert.strictEqual(providerDisplayName('local', {}, {}, 'ws/qwen3:8b'), 'ws');
  });
  it('uses the provider label, or the key', () => {
    assert.strictEqual(providerDisplayName('openrouter', { openrouter: { label: 'OpenRouter' } }, {}, 'deepseek/x'), 'OpenRouter');
    assert.strictEqual(providerDisplayName('zed', {}, {}, 'x'), 'zed');
  });
});

describe('isFree and modelChip', () => {
  it('is free only for a priced entry at zero', () => {
    assert.strictEqual(isFree({ priced: true, cost: { input: 0, output: 0 } }), true);
    assert.strictEqual(isFree({ priced: true, cost: { input: 0, output: 1 } }), false);
    assert.strictEqual(isFree({ priced: false, cost: null }), false);
  });
  it('builds a chip', () => {
    const chip = modelChip({ provider: 'p', model: 'm', usable: false }, { p: { label: 'P' } }, {});
    assert.deepStrictEqual(chip, { name: 'm', provider: 'P', free: false, usable: false });
    assert.strictEqual(modelChip({ provider: 'p', model: 'm', name: 'Nice' }, {}, {}).name, 'Nice');
    assert.strictEqual(modelChip({ provider: 'p', model: 'm' }, {}, {}).usable, true);
  });
});

describe('roleStatus', () => {
  it('ok with a usable entry', () => assert.deepStrictEqual(roleStatus({ main: [ok] }, 'main'), { state: 'ok', message: '' }));
  it('warn when none usable', () => {
    const s = roleStatus({ main: [bad] }, 'main');
    assert.strictEqual(s.state, 'warn');
    assert.strictEqual(s.message, 'None of these can be used right now. Fix their keys under Providers & keys.');
  });
  it('main empty', () => assert.deepStrictEqual(roleStatus({}, 'main'),
    { state: 'warn', message: 'Nothing can answer you until Main has a model.' }));
  it('worker borrows from main', () => assert.deepStrictEqual(roleStatus({ main: [ok] }, 'worker'),
    { state: 'borrows', from: 'main', message: "Uses Main's models." }));
  it('utility borrows from worker, then main', () => {
    assert.strictEqual(roleStatus({ worker: [ok], main: [ok] }, 'utility').from, 'worker');
    assert.strictEqual(roleStatus({ worker: [ok], main: [ok] }, 'utility').message, "Uses Worker's models.");
    assert.strictEqual(roleStatus({ main: [ok] }, 'utility').from, 'main');
  });
  it('does not borrow unusable models', () => {
    assert.strictEqual(roleStatus({ main: [bad] }, 'worker').state, 'warn');
  });
  it('worker and utility warn with nothing found', () => {
    assert.strictEqual(roleStatus({}, 'worker').message, "Agents and tasks can't run.");
    assert.strictEqual(roleStatus({}, 'utility').message, "Chat titles and case wake-ups can't run.");
  });
  it('vision borrows an image-capable usable model', () => {
    const s = roleStatus({ main: [ok, eye] }, 'vision');
    assert.strictEqual(s.state, 'borrows');
    assert.strictEqual(s.message, 'Uses an image-capable model from your other roles.');
  });
  it('vision off with none', () => {
    assert.deepStrictEqual(roleStatus({ main: [ok, { ...eye, usable: false }] }, 'vision'),
      { state: 'off', message: 'Nothing in this profile can read images.' });
  });
  it('imageGeneration empty', () => assert.deepStrictEqual(roleStatus({}, 'imageGeneration'),
    { state: 'off', message: 'Uses the image provider set under Providers & keys.' }));
  it('custom role empty', () => assert.deepStrictEqual(roleStatus({}, 'research'),
    { state: 'borrows', message: 'Uses its fallback role.' }));
});
