// tests/models-profiles.test.js
// Profiles and roles (spec 2026-09-27 §6.1, §6.2): the data model, its
// validation and the store over settings.models.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { addSink } = require('../src/logging');
const { Profiles, normalizeProfile, normalizeCustomRole, ProfileError } = require('../src/models/profiles');
const { roleForTier, roleForAgent, normalizeTarget, isCustomRoleId, TIER_TO_ROLE, targetLabel } = require('../src/models/roles');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { mergeSettings } = require('../src/core/settings');

function memorySettings(initial = {}) {
  let settings = mergeSettings(initial);
  return { getSettings: () => settings, setSettings: (next) => { settings = mergeSettings(next); }, peek: () => settings };
}

function makeProfiles(initial = {}, extra = {}) {
  let n = 0;
  const mem = memorySettings(initial);
  const profiles = new Profiles({ getSettings: mem.getSettings, setSettings: mem.setSettings, createId: () => `id${++n}`, ...extra });
  return { profiles, mem };
}

const codeOf = (fn) => {
  try { fn(); } catch (err) { assert.ok(err instanceof ProfileError, `expected a ProfileError, got ${err}`); return err.code; }
  return null;
};

const target = (provider, model, effort = null) => ({ provider, model, effort });

describe('model roles', () => {
  it('maps tiers and agents onto roles', () => {
    assert.deepStrictEqual({ ...TIER_TO_ROLE }, { fast: 'utility', standard: 'worker', smart: 'main' });
    assert.strictEqual(roleForTier('Smart'), 'main');
    assert.strictEqual(roleForTier('bogus'), null);
    assert.strictEqual(roleForAgent({ inferenceTier: 'fast' }), 'utility');
    assert.strictEqual(roleForAgent({ role: 'main', inferenceTier: 'fast' }), 'main');
    assert.strictEqual(roleForAgent({ role: 'legal-drafting' }), 'legal-drafting');
    assert.strictEqual(roleForAgent({}), 'worker');
    assert.strictEqual(roleForAgent(null), 'worker');
  });

  it('normalizes a target', () => {
    assert.deepStrictEqual(normalizeTarget({ provider: ' OpenAI ', model: ' gpt-5.5 ', effort: 'low' }), target('openai', 'gpt-5.5', 'low'));
    assert.deepStrictEqual(normalizeTarget({ provider: 'openai', model: 'gpt-5.5', effort: '' }), target('openai', 'gpt-5.5'));
    assert.strictEqual(normalizeTarget({ provider: 'openai', model: '' }), null);
    assert.strictEqual(normalizeTarget({ model: 'gpt-5.5' }), null);
    assert.strictEqual(normalizeTarget(null), null);
    assert.strictEqual(targetLabel(target('openai', 'gpt-5.5')), 'openai/gpt-5.5');
  });

  it('accepts custom role ids that are lowercase slugs and not built-in', () => {
    assert.strictEqual(isCustomRoleId('legal-drafting'), true);
    assert.strictEqual(isCustomRoleId('main'), false);
    assert.strictEqual(isCustomRoleId('vision'), false);
    assert.strictEqual(isCustomRoleId('imagegeneration'), false);
    assert.strictEqual(isCustomRoleId('Legal'), false);
    assert.strictEqual(isCustomRoleId('x'), false);
    assert.strictEqual(isCustomRoleId(7), false);
  });
});

describe('normalizeProfile', () => {
  it('fills the core roles, keeps specialist and custom roles, dedupes and lowercases', () => {
    const p = normalizeProfile({
      id: 'p-1',
      name: '  Anthropic only ',
      roles: {
        main: [{ provider: 'Anthropic', model: 'claude-sonnet-4-5' }, { provider: 'anthropic', model: ' claude-sonnet-4-5 ' }],
        vision: [{ provider: 'openai', model: 'gpt-5.5' }],
        'legal-drafting': [{ provider: 'openai', model: 'gpt-5.4', effort: 'high' }]
      }
    });
    assert.deepStrictEqual(p, {
      id: 'p-1',
      name: 'Anthropic only',
      kind: 'user',
      roles: {
        main: [target('anthropic', 'claude-sonnet-4-5')],
        worker: [],
        utility: [],
        vision: [target('openai', 'gpt-5.5')],
        'legal-drafting': [target('openai', 'gpt-5.4', 'high')]
      }
    });
  });

  it('keeps a migration record', () => {
    const p = normalizeProfile({ id: 'p-1', name: 'Migrated settings', kind: 'migrated', roles: {}, migration: { at: '2026-09-27T00:00:00.000Z', notes: ['a note'] } });
    assert.deepStrictEqual(p.migration, { at: '2026-09-27T00:00:00.000Z', notes: ['a note'] });
    assert.strictEqual(p.kind, 'migrated');
  });

  it('refuses bad input with a code and a message', () => {
    assert.strictEqual(codeOf(() => normalizeProfile(null)), 'BAD_PROFILE');
    assert.strictEqual(codeOf(() => normalizeProfile({ id: 'p', name: '   ' })), 'BAD_NAME');
    assert.strictEqual(codeOf(() => normalizeProfile({ id: 'p', name: 'x'.repeat(81) })), 'BAD_NAME');
    assert.strictEqual(codeOf(() => normalizeProfile({ id: 'p', name: 'x', kind: 'boss' })), 'BAD_KIND');
    assert.strictEqual(codeOf(() => normalizeProfile({ id: 'p', name: 'x', roles: { Main: [] } })), 'BAD_ROLE');
    assert.strictEqual(codeOf(() => normalizeProfile({ id: 'p', name: 'x', roles: { main: {} } })), 'BAD_ROLE');
    assert.strictEqual(codeOf(() => normalizeProfile({ id: 'p', name: 'x', roles: { main: [{ provider: 'openai' }] } })), 'BAD_TARGET');
    assert.strictEqual(codeOf(() => normalizeProfile({ name: 'x' })), 'BAD_ID');
    assert.strictEqual(normalizeProfile({ name: 'x' }, { requireId: false }).id, null);
    try {
      normalizeProfile({ id: 'p', name: 'x', roles: { main: [{ provider: 'openai', model: '' }] } });
    } catch (err) {
      assert.match(err.message, /Every model in role "main" needs a provider and a model/);
    }
  });

  it('normalizes a custom role, or drops it', () => {
    assert.deepStrictEqual(
      normalizeCustomRole({ id: 'legal-drafting', description: ' Contracts ', needs: { toolCall: true, minContext: 100000, other: 1 }, fallback: 'worker' }),
      { id: 'legal-drafting', description: 'Contracts', needs: { toolCall: true, minContext: 100000 }, fallback: 'worker' }
    );
    assert.strictEqual(normalizeCustomRole({ id: 'main', fallback: 'worker' }), null);
    assert.strictEqual(normalizeCustomRole({ id: 'legal-drafting', fallback: 'vision' }), null);
  });
});

describe('Profiles', () => {
  it('creates, lists and makes the first profile the default', () => {
    const { profiles, mem } = makeProfiles();
    assert.deepStrictEqual(profiles.list(), []);
    assert.strictEqual(profiles.defaultId(), null);
    const a = profiles.create({ name: 'Anthropic only', roles: { main: [target('anthropic', 'claude-sonnet-4-5')] } });
    assert.strictEqual(a.id, 'p-id1');
    assert.strictEqual(profiles.defaultId(), 'p-id1');
    const b = profiles.create({ name: 'Cheap' });
    assert.strictEqual(profiles.defaultId(), 'p-id1', 'a second profile does not take the default');
    assert.deepStrictEqual(profiles.list().map((p) => p.id), [a.id, b.id]);
    assert.deepStrictEqual(profiles.get(b.id).roles, { main: [], worker: [], utility: [] });
    assert.strictEqual(mem.peek().models.defaultProfileId, 'p-id1');
  });

  it('falls back to the first profile when the stored default names none', () => {
    const { profiles } = makeProfiles({ models: { profiles: [{ id: 'p-a', name: 'A', roles: {} }], defaultProfileId: 'p-gone' } });
    assert.strictEqual(profiles.defaultId(), 'p-a');
    assert.strictEqual(profiles.getDefault().name, 'A');
  });

  it('updates, refuses duplicate names, duplicates with a free name', () => {
    const { profiles } = makeProfiles();
    const a = profiles.create({ name: 'Work' });
    profiles.create({ name: 'Home' });
    const updated = profiles.update(a.id, { roles: { worker: [target('openai', 'gpt-5.4')] } });
    assert.deepStrictEqual(updated.roles.worker, [target('openai', 'gpt-5.4')]);
    assert.strictEqual(updated.name, 'Work');
    assert.strictEqual(codeOf(() => profiles.update(a.id, { name: 'home' })), 'DUPLICATE_NAME');
    assert.strictEqual(codeOf(() => profiles.create({ name: 'WORK' })), 'DUPLICATE_NAME');
    assert.strictEqual(codeOf(() => profiles.update('p-none', { name: 'x' })), 'NOT_FOUND');
    const copy = profiles.duplicate(a.id);
    assert.strictEqual(copy.name, 'Work copy');
    assert.strictEqual(copy.kind, 'user');
    assert.deepStrictEqual(copy.roles, updated.roles);
    assert.strictEqual(profiles.duplicate(a.id).name, 'Work copy 2');
  });

  it('removes a profile and moves the default; never the last one', () => {
    const { profiles } = makeProfiles();
    const a = profiles.create({ name: 'A' });
    const b = profiles.create({ name: 'B' });
    const r = profiles.remove(a.id);
    assert.strictEqual(r.removed.id, a.id);
    assert.strictEqual(r.defaultProfileId, b.id);
    assert.strictEqual(profiles.defaultId(), b.id);
    assert.strictEqual(codeOf(() => profiles.remove(b.id)), 'LAST_PROFILE');
    assert.strictEqual(codeOf(() => profiles.remove('p-none')), 'NOT_FOUND');
    assert.strictEqual(codeOf(() => profiles.setDefault('p-none')), 'NOT_FOUND');
  });

  it('checks an effort against the catalog', () => {
    const { profiles } = makeProfiles({}, { catalog: fixtureCatalog() });
    const ok = profiles.create({ name: 'Efforts', roles: { utility: [target('openai', 'gpt-5.5', 'low')] } });
    assert.strictEqual(ok.roles.utility[0].effort, 'low');
    assert.strictEqual(codeOf(() => profiles.update(ok.id, { roles: { utility: [target('openai', 'gpt-5.5', 'extreme')] } })), 'BAD_EFFORT');
    assert.strictEqual(codeOf(() => profiles.update(ok.id, { roles: { utility: [target('openai', 'gpt-4o', 'low')] } })), 'BAD_EFFORT');
    // A model the catalog does not know keeps whatever effort it was given.
    assert.strictEqual(profiles.update(ok.id, { roles: { utility: [target('openai', 'gpt-private', 'low')] } }).roles.utility[0].effort, 'low');
  });

  it('skips a malformed stored profile with a warning', () => {
    const lines = [];
    const remove = addSink((r) => { if (r.level === 'warn') lines.push(r.line); });
    try {
      const { profiles } = makeProfiles({ models: { profiles: [{ id: 'p-bad', name: '' }, { id: 'p-ok', name: 'OK', roles: {} }] } });
      assert.deepStrictEqual(profiles.list().map((p) => p.id), ['p-ok']);
    } finally {
      remove();
    }
    assert.ok(lines.some((l) => l.includes('p-bad')), lines.join('\n'));
  });

  it('reads custom roles, dropping invalid ones', () => {
    const { profiles } = makeProfiles({ models: { customRoles: [{ id: 'legal-drafting', fallback: 'worker' }, { id: 'Bad', fallback: 'main' }] } });
    assert.deepStrictEqual(profiles.customRoles(), [{ id: 'legal-drafting', description: '', needs: {}, fallback: 'worker' }]);
  });
});
