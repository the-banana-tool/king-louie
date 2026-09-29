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

function setup({ chats = [], unusable = {}, cases = {}, facade = false } = {}) {
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
  const facadeCalls = [];
  const choices = createModelChoices({
    profiles,
    catalog: fixtureCatalog(),
    availability,
    explainTarget,
    snapshotModels,
    getChats: () => store,
    listChats: (options = {}) => {
      if (facade) facadeCalls.push({ method: 'listChats', options });
      return options.messages === false ? store.map(({ messages: _messages, ...meta }) => meta) : store;
    },
    setChats: (next) => { store = next; },
    ...(facade ? {
      getChat: (chatId, options) => {
        facadeCalls.push({ method: 'getChat', chatId, options });
        return store.find((c) => c.id === chatId) || null;
      },
      updateChat: (chatId, patch) => {
        facadeCalls.push({ method: 'updateChat', chatId, patch });
        store = store.map((c) => (c.id === chatId ? { ...c, ...patch } : c));
        return store.find((c) => c.id === chatId) || null;
      }
    } : {}),
    appendMessageToChat: (chatId, sender, text) => { store = store.map((c) => (c.id === chatId ? { ...c, messages: [...c.messages, { sender, text }] } : c)); return store.find((c) => c.id === chatId); },
    getCaseRuntime: () => caseRuntime
  });
  const chat = (id) => store.find((c) => c.id === id);
  const statuses = (id) => chat(id).messages.filter((m) => m.sender === 'status').map((m) => m.text);
  return { choices, profiles, chat, statuses, caseCalls, caseMeta, facadeCalls };
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

  it('uses facade methods for chat model choice reads and writes when available', async () => {
    const { choices, chat, facadeCalls } = setup({ chats: [{ id: 'c1' }], facade: true });

    await choices.setChatProfile('c1', 'p-b');

    assert.strictEqual(chat('c1').profileId, 'p-b');
    assert.deepStrictEqual(facadeCalls.map((call) => [call.method, call.chatId]), [
      ['getChat', 'c1'],
      ['updateChat', 'c1'],
      ['getChat', 'c1']
    ]);
    assert.deepStrictEqual(Object.keys(facadeCalls[1].patch).sort(), ['profileId', 'updatedAt']);
  });

  it('refuses to switch to a model that cannot be used', async () => {
    const { choices, chat } = setup({ chats: [{ id: 'c1' }], unusable: { 'groq/llama-3.3-70b': 'No token saved for Groq.' } });
    await assert.rejects(choices.setMainOverride('c1', t('groq', 'llama-3.3-70b')), /groq\/llama-3\.3-70b cannot be used: No token saved for Groq\./);
    await assert.rejects(choices.setMainOverride('c1', { provider: 'openai' }), /Pick a model/);
    assert.strictEqual('mainOverride' in chat('c1'), false);
  });

  it('in a case chat, writes case.yaml through the case runtime', async () => {
    const { choices, chat, statuses, caseCalls } = setup({ chats: [{ id: 'c1', caseId: 'case-1' }], cases: { 'case-1': {} } });
    // A bad effort is refused for a case chat the same as a plain one, and
    // writes nothing to case.yaml.
    await assert.rejects(choices.setMainOverride('c1', t('openai', 'gpt-5.5', 'extreme')), /does not offer the effort "extreme"/);
    assert.deepStrictEqual(caseCalls, []);
    await choices.setMainOverride('c1', t('openai', 'gpt-4o'));
    await choices.setChatProfile('c1', 'p-b');
    assert.deepStrictEqual(caseCalls, [['case-1', { mainOverride: t('openai', 'gpt-4o') }], ['case-1', { profile: 'p-b' }]]);
    assert.strictEqual('mainOverride' in chat('c1'), false, 'the chat itself is untouched');
    assert.deepStrictEqual(statuses('c1'), ['Main model switched from GPT-5.5 to GPT-4o', 'This case now uses the profile Cheap.']);
    assert.strictEqual(choices.chatView('c1').chosenProfileId, 'p-b');
  });

  it('names the first usable main model in the status text, not just the first configured one', async () => {
    const { choices, statuses } = setup({
      chats: [{ id: 'c1', mainOverride: t('openai', 'gpt-4o') }],
      unusable: { 'openai/gpt-5.5': 'OpenAI connection test failed.' }
    });
    // The profile's main is [gpt-5.5, claude-sonnet-4-5]; gpt-5.5 (first
    // configured) is unusable here, so the model actually in use once the
    // override is cleared is claude-sonnet-4-5 — the first *usable* one.
    await choices.setMainOverride('c1', null);
    assert.deepStrictEqual(statuses('c1'), ['Main model reset to the profile\'s main (Claude Sonnet 4.5)']);
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

describe('main override efforts', () => {
  it('refuses a bad effort and saves nothing', async () => {
    const { choices, chat } = setup({ chats: [{ id: 'c1' }] });
    await assert.rejects(
      choices.setMainOverride('c1', t('openai', 'gpt-5.5', 'extreme')),
      /gpt-5\.5 in role "main" does not offer the effort "extreme"; it offers none, low, medium, high, xhigh\./
    );
    assert.strictEqual('mainOverride' in chat('c1'), false);
  });

  it('saves a good effort', async () => {
    const { choices, chat } = setup({ chats: [{ id: 'c1' }] });
    await choices.setMainOverride('c1', t('openai', 'gpt-5.5', 'high'));
    assert.deepStrictEqual(chat('c1').mainOverride, t('openai', 'gpt-5.5', 'high'));
  });

  it('picking a profile main entry keeps the effort the profile configured (m4)', async () => {
    const { choices, profiles, chat } = setup({ chats: [{ id: 'c1' }] });
    profiles.update('p-a', { roles: { ...profiles.get('p-a').roles, main: [t('openai', 'gpt-5.5', 'high'), t('anthropic', 'claude-sonnet-4-5')] } });
    const v = choices.chatView('c1');
    assert.deepStrictEqual(v.choices.map((c) => [`${c.provider}/${c.model}`, c.effort ?? null]), [
      ['openai/gpt-5.5', 'high'], ['anthropic/claude-sonnet-4-5', null], ['openai/gpt-4o', null], ['groq/llama-3.3-70b', null]
    ]);
    const picked = v.choices[0];
    await choices.setMainOverride('c1', { provider: picked.provider, model: picked.model, effort: picked.effort });
    assert.deepStrictEqual(chat('c1').mainOverride, t('openai', 'gpt-5.5', 'high'));
  });

  it('is fine with no effort', async () => {
    const { choices, chat } = setup({ chats: [{ id: 'c1' }] });
    await choices.setMainOverride('c1', t('openai', 'gpt-4o'));
    assert.deepStrictEqual(chat('c1').mainOverride, t('openai', 'gpt-4o'));
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

  it('uses facade metadata listing while moving chats and case chats off a deleted profile', async () => {
    const { choices, facadeCalls } = setup({
      chats: [{ id: 'c1', profileId: 'p-b' }, { id: 'c2', caseId: 'case-1' }, { id: 'c3' }],
      cases: { 'case-1': { profile: 'p-b' } },
      facade: true
    });

    const r = await choices.removeProfile('p-b');

    assert.deepStrictEqual(r.moved, { chats: ['c1'], cases: ['case-1'] });
    assert.ok(facadeCalls.some((call) => call.method === 'listChats' && call.options.messages === false));
    assert.ok(!facadeCalls.some((call) => call.method === 'getChats'), 'removeProfile should not need full chat payloads when listChats exists');
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
