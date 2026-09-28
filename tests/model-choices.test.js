// tests/model-choices.test.js
// The owner's model choices between turns (spec 2026-09-27 §6.5, §9, §11,
// §15): the header view and Retry with…'s list, the profile picker, the main
// switch with its status message, and a deleted profile moving its chats
// and cases to the default.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createModelChoices } = require('../src/core/model-choices');
const { Profiles } = require('../src/models/profiles');
const { mergeSettings } = require('../src/core/settings');
const { fixtureCatalog } = require('./helpers/models-fixture');

const t = (provider, model, effort = null) => ({ provider, model, effort });

function setup({ chats = [], unusable = {}, cases = {} } = {}) {
  let settings = mergeSettings({
    models: {
      profiles: [
        { id: 'p-a', name: 'Work', roles: { main: [t('openai', 'gpt-5.5'), t('anthropic', 'claude-sonnet-4-5')], worker: [t('openai', 'gpt-5.4')] } },
        { id: 'p-b', name: 'Cheap', roles: { main: [t('openai', 'gpt-5.4-mini')] } }
      ],
      defaultProfileId: 'p-a'
    }
  });
  let n = 0;
  const profiles = new Profiles({ getSettings: () => settings, setSettings: (s) => { settings = mergeSettings(s); }, createId: () => `id${++n}` });
  let store = chats.map((c) => ({ messages: [], ...c }));
  const explainTarget = (p, m) => (unusable[`${p}/${m}`] ? { usable: false, reasons: [unusable[`${p}/${m}`]], notes: [] } : { usable: true, reasons: [], notes: [] });
  const caseCalls = [];
  const caseMeta = { ...cases };
  const caseRuntime = {
    getCase: (id) => { if (!caseMeta[id]) throw new Error('Case not found'); return { id, ...caseMeta[id] }; },
    listCases: () => Object.keys(caseMeta).map((id) => ({ id, ...caseMeta[id] })),
    setModelChoice: async (id, patch) => { caseCalls.push([id, patch]); caseMeta[id] = { ...caseMeta[id], ...patch }; return { id, ...caseMeta[id] }; }
  };
  const snapshotModels = ({ chatId = null } = {}) => {
    const chat = chatId ? store.find((c) => c.id === chatId) : null;
    const meta = chat?.caseId ? caseMeta[chat.caseId] : null;
    const profileId = meta?.profile || chat?.profileId || null;
    const mainOverride = chat?.caseId ? (meta?.mainOverride || null) : (chat?.mainOverride || null);
    return profiles.snapshot({ profileId, mainOverride, explain: explainTarget });
  };
  const availability = {
    usable: () => [
      { provider: 'openai', model: 'gpt-5.5', name: 'GPT-5.5' },
      { provider: 'openai', model: 'gpt-4o', name: 'GPT-4o' },
      { provider: 'groq', model: 'llama-3.3-70b', name: 'Llama 3.3 70B' }
    ]
  };
  const choices = createModelChoices({
    profiles,
    catalog: fixtureCatalog(),
    availability,
    explainTarget,
    snapshotModels,
    getChats: () => store,
    setChats: (next) => { store = next; },
    appendMessageToChat: (chatId, sender, text) => { store = store.map((c) => (c.id === chatId ? { ...c, messages: [...c.messages, { sender, text }] } : c)); return store.find((c) => c.id === chatId); },
    getCaseRuntime: () => caseRuntime
  });
  const chat = (id) => store.find((c) => c.id === id);
  const statuses = (id) => chat(id).messages.filter((m) => m.sender === 'status').map((m) => m.text);
  return { choices, profiles, chat, statuses, caseCalls, caseMeta };
}

describe('the chat header view', () => {
  it('shows the profile, the main model, and usable choices with main\'s first', () => {
    const { choices } = setup({ chats: [{ id: 'c1' }] });
    const v = choices.chatView('c1');
    assert.deepStrictEqual(v.profile, { id: 'p-a', name: 'Work' });
    assert.deepStrictEqual([v.chosenProfileId, v.defaultProfileId, v.overridden], [null, 'p-a', false]);
    assert.deepStrictEqual(v.main, { provider: 'openai', model: 'gpt-5.5', name: 'GPT-5.5', usable: true, reasons: [] });
    assert.deepStrictEqual(v.choices.map((c) => [`${c.provider}/${c.model}`, c.inMain]), [
      ['openai/gpt-5.5', true], ['anthropic/claude-sonnet-4-5', true], ['openai/gpt-4o', false], ['groq/llama-3.3-70b', false]
    ]);
    assert.deepStrictEqual(v.profiles.map((p) => p.name), ['Work', 'Cheap']);
  });

  it('shows an unusable override with its reason', () => {
    const { choices } = setup({ chats: [{ id: 'c1', mainOverride: t('groq', 'llama-3.3-70b') }], unusable: { 'groq/llama-3.3-70b': 'No token saved for Groq.' } });
    const v = choices.chatView('c1');
    assert.strictEqual(v.overridden, true);
    assert.deepStrictEqual([v.main.model, v.main.usable, v.main.reasons], ['llama-3.3-70b', false, ['No token saved for Groq.']]);
  });

  it('refuses an unknown chat', () => {
    assert.throws(() => setup().choices.chatView('nope'), /Chat not found/);
  });
});

describe('switching', () => {
  it('sets and clears a chat\'s main override, each with a status message', async () => {
    const { choices, chat, statuses } = setup({ chats: [{ id: 'c1' }] });
    await choices.setMainOverride('c1', { provider: 'OpenAI', model: 'gpt-4o' });
    assert.deepStrictEqual(chat('c1').mainOverride, t('openai', 'gpt-4o'));
    await choices.setMainOverride('c1', null);
    assert.strictEqual('mainOverride' in chat('c1'), false);
    assert.deepStrictEqual(statuses('c1'), ['Main model switched from GPT-5.5 to GPT-4o', 'Main model reset to the profile\'s main (GPT-5.5)']);
  });

  it('refuses to switch to a model that cannot be used', async () => {
    const { choices, chat } = setup({ chats: [{ id: 'c1' }], unusable: { 'groq/llama-3.3-70b': 'No token saved for Groq.' } });
    await assert.rejects(choices.setMainOverride('c1', t('groq', 'llama-3.3-70b')), /groq\/llama-3\.3-70b cannot be used: No token saved for Groq\./);
    await assert.rejects(choices.setMainOverride('c1', { provider: 'openai' }), /Pick a model/);
    assert.strictEqual('mainOverride' in chat('c1'), false);
  });

  it('in a case chat, writes case.yaml through the case runtime', async () => {
    const { choices, chat, statuses, caseCalls } = setup({ chats: [{ id: 'c1', caseId: 'case-1' }], cases: { 'case-1': {} } });
    await choices.setMainOverride('c1', t('openai', 'gpt-4o'));
    await choices.setChatProfile('c1', 'p-b');
    assert.deepStrictEqual(caseCalls, [['case-1', { mainOverride: t('openai', 'gpt-4o') }], ['case-1', { profile: 'p-b' }]]);
    assert.strictEqual('mainOverride' in chat('c1'), false, 'the chat itself is untouched');
    assert.deepStrictEqual(statuses('c1'), ['Main model switched from GPT-5.5 to GPT-4o', 'This case now uses the profile Cheap.']);
    assert.strictEqual(choices.chatView('c1').chosenProfileId, 'p-b');
  });

  it('picks and clears a chat profile', async () => {
    const { choices, chat, statuses } = setup({ chats: [{ id: 'c1' }] });
    await choices.setChatProfile('c1', 'p-b');
    assert.strictEqual(chat('c1').profileId, 'p-b');
    await choices.setChatProfile('c1', null);
    assert.strictEqual('profileId' in chat('c1'), false);
    assert.deepStrictEqual(statuses('c1'), ['This chat now uses the profile Cheap.', 'This chat now uses the default profile (Work).']);
    await assert.rejects(choices.setChatProfile('c1', 'p-gone'), /No profile with id p-gone/);
  });
});

describe('profiles', () => {
  it('a deleted profile moves its chats and cases to the default, saying so', async () => {
    const { choices, chat, statuses, caseCalls } = setup({
      chats: [{ id: 'c1', profileId: 'p-b' }, { id: 'c2', caseId: 'case-1' }, { id: 'c3' }],
      cases: { 'case-1': { profile: 'p-b' } }
    });
    const r = await choices.removeProfile('p-b');
    assert.deepStrictEqual(r, { removed: 'p-b', defaultProfileId: 'p-a', moved: { chats: ['c1'], cases: ['case-1'] } });
    assert.strictEqual('profileId' in chat('c1'), false);
    assert.deepStrictEqual(caseCalls, [['case-1', { profile: null }]]);
    assert.deepStrictEqual(statuses('c1'), ['The profile Cheap was deleted; this chat now uses the default profile (Work).']);
    assert.deepStrictEqual(statuses('c2'), ['The profile Cheap was deleted; this case now uses the default profile (Work).']);
    assert.deepStrictEqual(statuses('c3'), []);
  });

  it('views every profile entry with its usability, reasons and catalog facts', () => {
    const { choices } = setup({ unusable: { 'anthropic/claude-sonnet-4-5': 'Anthropic has not been tested yet.' } });
    const view = choices.profilesView();
    assert.strictEqual(view.defaultProfileId, 'p-a');
    const [a] = view.profiles;
    assert.deepStrictEqual(a.roles.main.map((e) => [e.name, e.usable, e.reasons]), [['GPT-5.5', true, []], ['Claude Sonnet 4.5', false, ['Anthropic has not been tested yet.']]]);
    assert.deepStrictEqual([a.roles.main[0].priced, a.roles.main[0].cost, a.roles.main[0].context], [true, { input: 5, output: 30 }, 1050000]);
    assert.deepStrictEqual(a.roles.main[0].efforts, ['none', 'low', 'medium', 'high', 'xhigh']);
  });

  it('saves, duplicates and sets the default', () => {
    const { choices, profiles } = setup();
    const created = choices.saveProfile({ name: 'Local', roles: { main: [t('ollama', 'llama3.2')] } });
    assert.strictEqual(created.name, 'Local');
    const renamed = choices.saveProfile({ id: created.id, name: 'Local only', roles: created.roles });
    assert.strictEqual(renamed.name, 'Local only');
    assert.strictEqual(choices.duplicateProfile('p-a').name, 'Work copy');
    assert.strictEqual(choices.setDefaultProfile(created.id), created.id);
    assert.strictEqual(profiles.defaultId(), created.id);
  });

  it('lists usable picker models, then the catalog\'s unusable ones with reasons', () => {
    const { choices } = setup({ unusable: { 'groq/llama-vision-preview': 'No token saved for Groq.' } });
    const picker = choices.pickerView({ needs: {} });
    assert.deepStrictEqual(picker.usable.map((c) => c.model), ['gpt-5.5', 'gpt-4o', 'llama-3.3-70b']);
    const vision = picker.unusable.find((c) => c.model === 'llama-vision-preview');
    assert.deepStrictEqual([vision.usable, vision.reasons], [false, ['No token saved for Groq.']]);
    assert.ok(!picker.unusable.some((c) => c.model === 'gpt-image-1'), 'no image-only models');
  });
});
