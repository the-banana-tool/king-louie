// tests/models-resolver.test.js
// The resolver (spec 2026-09-27 §6.3–§6.6): usable targets in order with
// the reasons for every skipped one, needs filtering, borrowing and
// fallbacks, the main override, unknown roles, and a frozen snapshot.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { addSink } = require('../src/logging');
const { createTurnModels, UnknownRoleError, NoUsableModelError, roleTimeoutMs } = require('../src/models/resolver');
const { Profiles, snapshotFromSettings } = require('../src/models/profiles');
const { mergeSettings } = require('../src/core/settings');

const t = (provider, model, effort = null) => ({ provider, model, effort });

// Usable unless listed; a listed model gets that reason. `seen` records the
// needs each call was asked about.
function explainer(unusable = {}, { images = [], tools = null } = {}) {
  const seen = [];
  const explain = (provider, model, { needs = {} } = {}) => {
    seen.push({ provider, model, needs });
    const key = `${provider}/${model}`;
    const reasons = [];
    if (unusable[key]) reasons.push(unusable[key]);
    if (needs.imageInput && !images.includes(key)) reasons.push(`${model} takes no image input.`);
    if (needs.toolCall && tools && !tools.includes(key)) reasons.push(`${model} has no tool calling.`);
    return { usable: reasons.length === 0, reasons, notes: [] };
  };
  return { explain, seen };
}

const profile = (roles, extra = {}) => ({ id: 'p-1', name: 'Work', kind: 'user', roles: { main: [], worker: [], utility: [], ...roles }, ...extra });

describe('TurnModels.resolve', () => {
  it('returns the usable targets in order and every skipped one with its reasons', () => {
    const { explain } = explainer({ 'groq/llama-3.3-70b': 'Groq connection test failed: Invalid API Key' });
    const m = createTurnModels({ profile: profile({ main: [t('groq', 'llama-3.3-70b'), t('openai', 'gpt-5.5'), t('anthropic', 'claude-sonnet-4-5')] }), explain });
    const r = m.resolve('main');
    assert.deepStrictEqual(r.targets, [t('openai', 'gpt-5.5'), t('anthropic', 'claude-sonnet-4-5')]);
    assert.deepStrictEqual(r.skipped, [{ target: t('groq', 'llama-3.3-70b'), reasons: ['Groq connection test failed: Invalid API Key'] }]);
    assert.strictEqual(r.borrowedFrom, null);
    assert.strictEqual(r.override, false);
    assert.strictEqual(m.profileId, 'p-1');
    assert.strictEqual(m.profileName, 'Work');
  });

  it('passes the call needs to every check', () => {
    const { explain, seen } = explainer({}, { tools: ['openai/gpt-5.5'] });
    const m = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-3.5-turbo'), t('openai', 'gpt-5.5')] }), explain });
    const r = m.resolve('main', { needs: { toolCall: true } });
    assert.deepStrictEqual(r.targets, [t('openai', 'gpt-5.5')]);
    assert.deepStrictEqual(seen.map((s) => s.needs), [{ toolCall: true }, { toolCall: true }]);
  });

  it('uses only the main override when one is set, flagged, and never the profile list', () => {
    const { explain } = explainer({ 'openai/gpt-5.5': 'OpenAI connection test failed: timeout' });
    const m = createTurnModels({ profile: profile({ main: [t('anthropic', 'claude-sonnet-4-5')] }), mainOverride: { provider: 'OpenAI', model: 'gpt-5.5' }, explain });
    assert.deepStrictEqual(m.mainOverride, t('openai', 'gpt-5.5'));
    const r = m.resolve('main');
    assert.deepStrictEqual(r.targets, []);
    assert.strictEqual(r.override, true);
    assert.deepStrictEqual(m.candidatesFor('main'), [t('openai', 'gpt-5.5')]);
    assert.deepStrictEqual(m.configuredFor('main'), [t('anthropic', 'claude-sonnet-4-5')]);
    assert.throws(() => m.mustResolve('main'), (err) => err instanceof NoUsableModelError
      && err.code === 'MAIN_OVERRIDE_UNUSABLE'
      && /The main model override openai\/gpt-5\.5 is not usable: OpenAI connection test failed: timeout/.test(err.message));
  });

  it('fails an empty main without borrowing, and lists every skipped target when none is usable', () => {
    const { explain } = explainer({ 'groq/a': 'no key', 'openai/b': 'test failed' });
    const empty = createTurnModels({ profile: profile({ worker: [t('openai', 'gpt-5.4')] }), explain });
    assert.throws(() => empty.mustResolve('main'), (err) => err.code === 'NO_USABLE_MODEL' && /main has no models in the profile "Work"/.test(err.message));
    const none = createTurnModels({ profile: profile({ main: [t('groq', 'a'), t('openai', 'b')] }), explain });
    assert.throws(() => none.mustResolve('main'), (err) => err.code === 'NO_USABLE_MODEL'
      && err.skipped.length === 2
      && /Skipped: groq\/a \(no key\); openai\/b \(test failed\)/.test(err.message));
  });

  it('borrows an empty utility from worker, then main; an empty worker from main', () => {
    const { explain } = explainer();
    const m = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-5.5')], worker: [t('openai', 'gpt-5.4')] }), explain });
    assert.deepStrictEqual([m.resolve('utility').targets, m.resolve('utility').borrowedFrom], [[t('openai', 'gpt-5.4')], 'worker']);
    const onlyMain = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-5.5')] }), explain });
    assert.deepStrictEqual([onlyMain.resolve('utility').borrowedFrom, onlyMain.resolve('worker').borrowedFrom], ['main', 'main']);
    assert.deepStrictEqual(onlyMain.candidatesFor('utility'), [t('openai', 'gpt-5.5')]);
  });

  it('does not borrow when the role has models but none is usable', () => {
    const { explain } = explainer({ 'groq/llama-3.3-70b': 'Groq connection test failed' });
    const m = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-5.5')], utility: [t('groq', 'llama-3.3-70b')] }), explain });
    const r = m.resolve('utility');
    assert.deepStrictEqual([r.targets, r.borrowedFrom, r.skipped.length], [[], null, 1]);
  });

  it('borrows the main list, not the main override, for an empty worker', () => {
    const { explain } = explainer();
    const m = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-5.5')] }), mainOverride: t('anthropic', 'claude-sonnet-4-5'), explain });
    assert.deepStrictEqual(m.resolve('worker').targets, [t('openai', 'gpt-5.5')]);
  });

  it('checks vision entries for image input, and fills an empty vision from the first image-capable core model', () => {
    const { explain } = explainer({}, { images: ['openai/gpt-5.5', 'anthropic/claude-sonnet-4-5'] });
    const own = createTurnModels({ profile: profile({ vision: [t('groq', 'llama-3.3-70b'), t('openai', 'gpt-5.5')] }), explain });
    assert.deepStrictEqual(own.resolve('vision').targets, [t('openai', 'gpt-5.5')]);
    const borrowed = createTurnModels({ profile: profile({ utility: [t('groq', 'llama-3.3-70b')], worker: [t('anthropic', 'claude-sonnet-4-5')], main: [t('openai', 'gpt-5.5')] }), explain });
    const r = borrowed.resolve('vision');
    assert.deepStrictEqual([r.targets, r.borrowedFrom], [[t('anthropic', 'claude-sonnet-4-5')], 'worker']);
    const none = createTurnModels({ profile: profile({ main: [t('groq', 'llama-3.3-70b')] }), explain });
    assert.deepStrictEqual(none.resolve('vision').targets, []);
  });

  it('leaves an empty imageGeneration to its own settings', () => {
    const { explain } = explainer();
    const m = createTurnModels({ profile: profile({}), explain });
    const r = m.resolve('imageGeneration');
    assert.deepStrictEqual([r.targets, r.useSettings], [[], true]);
    assert.doesNotThrow(() => m.mustResolve('imageGeneration'));
  });

  it('resolves a custom role with its needs, and an empty one through its fallback', () => {
    const { explain, seen } = explainer({}, { tools: ['openai/gpt-5.5'] });
    const customRoles = [{ id: 'legal-drafting', description: '', needs: { toolCall: true }, fallback: 'worker' }];
    const filled = createTurnModels({ profile: profile({ 'legal-drafting': [t('openai', 'gpt-3.5-turbo'), t('openai', 'gpt-5.5')] }), customRoles, explain });
    assert.deepStrictEqual(filled.resolve('legal-drafting').targets, [t('openai', 'gpt-5.5')]);
    assert.ok(seen.every((s) => s.needs.toolCall === true));
    const empty = createTurnModels({ profile: profile({ worker: [t('openai', 'gpt-5.5')] }), customRoles, explain });
    const r = empty.resolve('legal-drafting');
    assert.deepStrictEqual([r.role, r.targets, r.borrowedFrom], ['legal-drafting', [t('openai', 'gpt-5.5')], 'worker']);
  });

  it('fails an unknown role, naming it', () => {
    const { explain } = explainer();
    const m = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-5.5')] }), explain });
    assert.throws(() => m.resolve('legal-drafting'), (err) => err instanceof UnknownRoleError && err.code === 'UNKNOWN_ROLE' && /Unknown model role "legal-drafting"/.test(err.message));
  });

  it('checks an explicit target alone, still for usability', () => {
    const { explain } = explainer({ 'groq/llama-3.3-70b': 'no key' });
    const m = createTurnModels({ profile: profile({ main: [t('openai', 'gpt-5.5')] }), explain });
    const ok = m.resolve('main', { explicit: { provider: 'Anthropic', model: 'claude-sonnet-4-5' } });
    assert.deepStrictEqual([ok.targets, ok.explicit], [[t('anthropic', 'claude-sonnet-4-5')], true]);
    const refused = m.resolve('main', { explicit: t('groq', 'llama-3.3-70b') });
    assert.deepStrictEqual(refused.targets, []);
    assert.throws(() => m.resolve('main', { explicit: { provider: 'openai' } }), /needs both a provider and a model/);
  });

  it('is frozen: later edits to the profile or override change nothing', () => {
    const { explain } = explainer();
    const source = profile({ main: [t('openai', 'gpt-5.5')] });
    const override = t('anthropic', 'claude-sonnet-4-5');
    const m = createTurnModels({ profile: source, mainOverride: override, explain });
    source.roles.main.push(t('groq', 'x'));
    source.roles.worker = [t('groq', 'y')];
    override.model = 'changed';
    assert.deepStrictEqual(m.configuredFor('main'), [t('openai', 'gpt-5.5')]);
    assert.deepStrictEqual(m.mainOverride, t('anthropic', 'claude-sonnet-4-5'));
    assert.deepStrictEqual(m.resolve('worker').borrowedFrom, 'main');
    assert.ok(Object.isFrozen(m));
  });

  it('works with no profile at all: main fails with a clear message', () => {
    const { explain } = explainer();
    const m = createTurnModels({ profile: null, explain });
    assert.strictEqual(m.profileId, null);
    assert.throws(() => m.mustResolve('main'), /main has no models in the profile "\(no profile\)"/);
  });
});

describe('snapshots from profiles', () => {
  function store(models) {
    let settings = mergeSettings({ models });
    return new Profiles({ getSettings: () => settings, setSettings: (s) => { settings = mergeSettings(s); } });
  }
  const models = {
    profiles: [
      { id: 'p-a', name: 'A', roles: { main: [t('openai', 'gpt-5.5')] } },
      { id: 'p-b', name: 'B', roles: { main: [t('anthropic', 'claude-sonnet-4-5')] } }
    ],
    defaultProfileId: 'p-b'
  };

  it('picks the named profile, else the default', () => {
    const { explain } = explainer();
    const profiles = store(models);
    assert.strictEqual(profiles.snapshot({ profileId: 'p-a', explain }).profileId, 'p-a');
    assert.strictEqual(profiles.snapshot({ explain }).profileId, 'p-b');
  });

  it('an unknown profile id falls back to the default', () => {
    const { explain } = explainer();
    const lines = [];
    const remove = addSink((r) => { if (r.level === 'warn') lines.push(r.line); });
    try {
      assert.strictEqual(store(models).snapshot({ profileId: 'p-gone', explain }).profileId, 'p-b');
    } finally {
      remove();
    }
    assert.ok(lines.some((l) => l.includes('p-gone')), lines.join('\n'));
  });

  it('snapshotFromSettings reads settings.models directly, with the override', () => {
    const { explain } = explainer();
    const m = snapshotFromSettings({ models }, { profileId: 'p-a', mainOverride: t('groq', 'x'), explain });
    assert.deepStrictEqual([m.profileId, m.mainOverride], ['p-a', t('groq', 'x')]);
    assert.strictEqual(snapshotFromSettings({}, { explain }).profileId, null);
  });

  it('carries the custom roles into the snapshot', () => {
    const { explain } = explainer();
    const m = store({ ...models, customRoles: [{ id: 'legal-drafting', fallback: 'main' }] }).snapshot({ explain });
    assert.strictEqual(m.resolve('legal-drafting').borrowedFrom, 'main');
  });
});

describe('roleTimeoutMs', () => {
  it('reads models.roleTimeoutsMs, mapping specialists and custom roles to a core role', () => {
    const settings = mergeSettings({ models: { roleTimeoutsMs: { utility: 5000 } } });
    assert.strictEqual(roleTimeoutMs(settings, 'main'), 90000);
    assert.strictEqual(roleTimeoutMs(settings, 'utility'), 5000);
    assert.strictEqual(roleTimeoutMs(settings, 'vision'), 30000);
    assert.strictEqual(roleTimeoutMs(settings, 'legal-drafting', [{ id: 'legal-drafting', fallback: 'utility' }]), 5000);
    assert.strictEqual(roleTimeoutMs({ models: { roleTimeoutsMs: { main: -1 } } }, 'main'), undefined);
  });
});
