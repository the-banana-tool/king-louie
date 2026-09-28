// tests/models-king-louie.test.js
// The King Louie profile (spec 2026-09-27 §7.2): proposals from the usable
// models, accepted only by the owner (or auto-accept), dismissed until the
// picks change, and recomputed when an input changes.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Profiles } = require('../src/models/profiles');
const { KingLouieProfile } = require('../src/models/king-louie');
const { createModelChoices } = require('../src/core/model-choices');
const { mergeSettings } = require('../src/core/settings');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const entry = (name, { input, output, intelligence = null, agentic = null, toolCall = true, context = 400000, efforts = [] }) => ({
  name,
  cost: input === undefined ? null : { input, output },
  scores: { intelligence, agentic },
  toolCall,
  input: ['text'],
  output: ['text'],
  limits: { context },
  local: false,
  reasoning: { efforts }
});

// Picks: main sonnet, big, mini; worker mini, sonnet, big; utility fast,
// mini (minimal effort), sonnet.
const ENTRIES = {
  'openai:big': entry('Big', { input: 5, output: 30, intelligence: 60, agentic: 50 }),
  'anthropic:sonnet': entry('Sonnet', { input: 3, output: 15, intelligence: 55, agentic: 48 }),
  'openai:mini': entry('Mini', { input: 0.25, output: 2, intelligence: 40, agentic: 42, efforts: ['minimal', 'low'] }),
  'groq:fast': entry('Fast', { input: 0.05, output: 0.1, intelligence: 32, toolCall: false, context: 128000 })
};

function memorySettings(initial = {}) {
  let settings = mergeSettings(initial);
  return { getSettings: () => settings, setSettings: (next) => { settings = mergeSettings(next); } };
}

function setup({ usable = Object.keys(ENTRIES), models = {}, usage = {} } = {}) {
  const mem = memorySettings({
    models: {
      profiles: [{ id: 'p-mine', name: 'Mine', kind: 'user', roles: { main: [{ provider: 'openai', model: 'big', effort: null }], worker: [], utility: [] } }],
      defaultProfileId: 'p-mine',
      ...models
    }
  });
  const state = { usable };
  const catalog = {
    get: (p, m) => (ENTRIES[`${p}:${m}`] ? structuredClone(ENTRIES[`${p}:${m}`]) : null),
    price: (p, m, u) => {
      const e = ENTRIES[`${p}:${m}`];
      return e?.cost ? { usd: ((u.input || 0) * e.cost.input + (u.output || 0) * e.cost.output) / 1e6 } : null;
    }
  };
  const availability = {
    usable: () => state.usable.map((key) => {
      const [provider, model] = key.split(':');
      return { provider, model, name: model };
    })
  };
  let n = 0;
  const profiles = new Profiles({ getSettings: mem.getSettings, setSettings: mem.setSettings, createId: () => `id${++n}` });
  const kl = new KingLouieProfile({ profiles, availability, catalog, getSettings: mem.getSettings, setSettings: mem.setSettings, getRecentUsage: () => usage, debounceMs: 5 });
  return { kl, profiles, mem, state, catalog };
}

describe('the King Louie profile', () => {
  it('defaults its settings through mergeSettings', () => {
    assert.deepStrictEqual(mergeSettings({}).models.kingLouie, {
      autoAccept: false, bandPoints: 3, workerAgenticRatio: 0.8, utilityIntelligenceRatio: 0.5,
      preferLocalUtility: false, blend: { input: 3, output: 1 }, dismissedProposalId: null
    });
    assert.deepStrictEqual(mergeSettings({ models: { kingLouie: { blend: { output: 2 } } } }).models.kingLouie.blend, { input: 3, output: 2 });
  });

  it('starts as a proposal; accepting creates it and leaves the default alone', () => {
    const { kl, profiles } = setup();
    assert.strictEqual(kl.profile(), null);
    const p = kl.propose();
    assert.deepStrictEqual(p.changes.map((c) => c.role), ['main', 'worker', 'utility']);
    assert.deepStrictEqual(p.roles.main.map((t) => t.model), ['sonnet', 'big', 'mini']);
    assert.deepStrictEqual(p.changes[0].to.map((t) => t.name), ['Sonnet', 'Big', 'Mini']);
    const saved = kl.accept(p.id);
    assert.deepStrictEqual([saved.kind, saved.name], ['king-louie', 'King Louie selected']);
    assert.deepStrictEqual(saved.roles.utility, [
      { provider: 'groq', model: 'fast', effort: null },
      { provider: 'openai', model: 'mini', effort: 'minimal' },
      { provider: 'anthropic', model: 'sonnet', effort: null }
    ]);
    assert.strictEqual(profiles.defaultId(), 'p-mine');
    assert.strictEqual(kl.propose().upToDate, true);
    assert.strictEqual(kl.view().upToDate, true);
  });

  it('accepting a proposal that changed since it was shown is refused and writes nothing', () => {
    const { kl, state, mem } = setup();
    const shown = kl.propose();
    state.usable = ['openai:big', 'openai:mini']; // a key was removed meanwhile
    const before = JSON.stringify(mem.getSettings().models.profiles);
    assert.throws(() => kl.accept(shown.id), (err) => err.code === 'STALE_PROPOSAL');
    assert.strictEqual(JSON.stringify(mem.getSettings().models.profiles), before);
  });

  it('a dismissed proposal stays hidden until the proposed models change', () => {
    const { kl, state } = setup();
    const first = kl.propose();
    kl.dismiss(first.id);
    assert.strictEqual(kl.propose().dismissed, true);
    assert.strictEqual(kl.view().proposal.dismissed, true);
    state.usable = ['openai:big', 'openai:mini', 'groq:fast'];
    const next = kl.propose();
    assert.notStrictEqual(next.id, first.id);
    assert.strictEqual(next.dismissed, false);
  });

  it('auto-accept takes a new proposal but never a dismissed one', () => {
    const { kl } = setup();
    kl.dismiss(kl.propose().id);
    kl.saveSettings({ autoAccept: true });
    assert.strictEqual(kl.profile(), null, 'a dismissed proposal is not auto-accepted');
    const { kl: fresh } = setup({ models: { kingLouie: { autoAccept: true } } });
    fresh.refresh();
    assert.strictEqual(fresh.profile().kind, 'king-louie');
  });

  it('recomputes once per burst of input changes and tells its listeners', async () => {
    const { kl } = setup();
    const views = [];
    kl.on('proposal', (v) => views.push(v));
    kl.inputsChanged();
    kl.inputsChanged();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.strictEqual(views.length, 1);
    assert.match(views[0].proposal.id, /^[0-9a-f]{16}$/);
  });

  it('says why when it cannot propose, and changes nothing', () => {
    const { kl } = setup({ usable: ['groq:fast'] });
    assert.match(kl.view().unavailable, /No usable model that calls tools has both a price and an agentic score/);
    assert.throws(() => kl.accept('anything'), (err) => err.code === 'NO_PROPOSAL');
    assert.strictEqual(kl.profile(), null);
  });

  it('estimates each change\'s monthly cost effect from recent usage', () => {
    const { kl } = setup({ usage: { utility: { calls: 10, unpricedCalls: 0, cost: 0.5, usage: { input: 1e6, cachedInput: 0, cacheWrite: 0, output: 1e6, reasoning: 0 } } } });
    const utility = kl.propose().changes.find((c) => c.role === 'utility');
    assert.deepStrictEqual(utility.costEffect, { usd: -0.35, note: '10 calls in the last 30 days, repriced.' });
  });

  it('"Duplicate as my profile" copies the picks into an ordinary profile', () => {
    const { kl } = setup();
    const copy = kl.duplicateAsProfile();
    assert.deepStrictEqual([copy.kind, copy.name], ['user', 'King Louie selected copy']);
    assert.deepStrictEqual(copy.roles.main.map((t) => t.model), ['sonnet', 'big', 'mini']);
  });

  it('checks its settings', () => {
    const { kl } = setup();
    assert.throws(() => kl.saveSettings({ bandPoints: -1 }), /The band is a number from 0 to 50/);
    assert.throws(() => kl.saveSettings({ workerAgenticRatio: 2 }), /The worker ratio is a number from 0 to 1/);
    assert.strictEqual(kl.saveSettings({ workerAgenticRatio: 0.95 }).workerAgenticRatio, 0.95);
  });
});

describe('the King Louie profile in the model choices', () => {
  const choicesFor = (kl, profiles) => createModelChoices({
    profiles,
    kingLouie: kl,
    explainTarget: () => ({ usable: true, reasons: [], notes: [] }),
    snapshotModels: () => null,
    getChats: () => [],
    setChats: () => {},
    appendMessageToChat: () => null
  });

  it('accepts, dismisses and duplicates through the choices, and keeps the profile out of the editor', () => {
    const { kl, profiles } = setup();
    const choices = choicesFor(kl, profiles);
    const view = choices.kingLouieView();
    const accepted = choices.acceptProposal(view.proposal.id);
    assert.strictEqual(accepted.kind, 'king-louie');
    assert.throws(
      () => choices.saveProfile({ id: accepted.id, name: 'Mine now', roles: { main: [] } }),
      (err) => err.code === 'KING_LOUIE_READ_ONLY' && /Duplicate it to make your own/.test(err.message)
    );
    assert.strictEqual(choices.duplicateKingLouie({}).kind, 'user');
    assert.strictEqual(choices.saveKingLouieSettings({ preferLocalUtility: true }).settings.preferLocalUtility, true);
  });
});

describe('the King Louie profile in the core', () => {
  const tempDirs = [];
  const savedCasesRoot = process.env.KL_CASES_ROOT;
  afterEach(() => {
    if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
    while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  });

  it('is built with the core and pushes its view when a provider\'s status changes', async () => {
    const { createCore } = require('../src/core');
    const { JsonFileStore } = require('../src/platform/json-file-store');
    const { createAesGcmCipher } = require('../src/platform/cipher');
    const { createHeadlessPrompter } = require('../src/platform/prompter');
    delete process.env.KL_CASES_ROOT;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-king-louie-'));
    tempDirs.push(dataDir);
    const sent = [];
    const core = createCore({
      paths: { dataDir },
      store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); },
      ui: { send: (channel, payload) => sent.push({ channel, payload }) }
    });
    try {
      await core.start();
      assert.strictEqual(core.models.kingLouie, core.context.getKingLouie());
      // A fresh install has no tested keys, so nothing can be proposed yet.
      assert.match(core.context.getModelChoices().kingLouieView().unavailable, /No usable model/);
      core.models.availability.emit('changed', { provider: 'openai', status: null });
      await new Promise((resolve) => setTimeout(resolve, 350));
      assert.ok(sent.some((e) => e.channel === 'models:proposalChanged' && e.payload.unavailable), JSON.stringify(sent.map((e) => e.channel)));
    } finally {
      await core.shutdown();
    }
  });
});
