// tests/models-headless.test.js
// Headless and agent runs (spec 2026-09-27 §8, §12): each agent runs on its
// role from the default profile — its pre-M2 tier read as the mapped role —
// or on a target its caller names, and a failing first target fails over.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ProviderFactory = require('../src/providers/provider-factory');
const { listAgents } = require('../src/agents');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { setActiveCatalog } = require('../src/models');
const { profileSettings } = require('./helpers/profile-settings');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const FAKE = 'kl-test-headless';
const t = (provider, model) => ({ provider, model, effort: null });
const tempDirs = [];
const savedCasesRoot = process.env.KL_CASES_ROOT;
afterEach(() => {
  ProviderFactory._registry.delete(FAKE);
  setActiveCatalog(null);
  if (savedCasesRoot === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedCasesRoot;
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// A registered fake provider: every call records the model it was asked
// for; a model named "down" fails the way an outage does.
function fakeProvider(used) {
  return class {
    constructor(apiKey) { this.apiKey = apiKey; }
    getProviderName() { return FAKE; }
    getDefaultModel() { return 'fake-default'; }
    async sendMessage() { return 'unused'; }
    async sendMessageWithTools(messages, tools, options) {
      used.push(options.model);
      if (options.model === 'down') throw new Error('upstream exploded');
      return { type: 'text', content: `answered by ${options.model}` };
    }
  };
}

async function startCore(roles) {
  const used = [];
  ProviderFactory.registerProvider(FAKE, fakeProvider(used));
  delete process.env.KL_CASES_ROOT;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-headless-'));
  tempDirs.push(dataDir);
  const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
  store.set('settings', profileSettings({}, roles));
  const core = createCore({
    paths: { dataDir },
    store,
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    fetch: async (url) => { throw new Error(`no network in unit tests (${url})`); }
  });
  await core.start();
  core.saveProviderToken(FAKE, 'fake-token-123456');
  return { core, used, adapter: core.context.getAgentExecutorAdapter() };
}

const agent = (id) => listAgents().find((a) => a.id === id);

describe('headless agent runs', () => {
  it('built-in agents run on their own roles', () => {
    const roles = Object.fromEntries(['main', 'planner', 'code-writer', 'code-explorer', 'case-researcher'].map((id) => [id, agent(id).role]));
    assert.deepStrictEqual(roles, { main: 'main', planner: 'main', 'code-writer': 'main', 'code-explorer': 'worker', 'case-researcher': 'worker' });
  });

  it('run on the agent\'s role; a user-defined agent\'s tier reads as the mapped role', async () => {
    const { core, used, adapter } = await startCore({ main: [t(FAKE, 'main-model')], worker: [t(FAKE, 'worker-model')], utility: [t(FAKE, 'utility-model')] });
    const Agent = require('../src/agents/agent-schema');
    const custom = (inferenceTier) => new Agent({ id: `custom-${inferenceTier}`, inferenceTier, allowedTools: ['Read'] });
    try {
      assert.strictEqual((await adapter.execute(agent('main'), 'hello')).content, 'answered by main-model');
      assert.strictEqual((await adapter.execute(agent('code-explorer'), 'hello')).content, 'answered by worker-model');
      assert.strictEqual((await adapter.execute(custom('fast'), 'hello')).content, 'answered by utility-model');
      assert.strictEqual((await adapter.execute(custom('standard'), 'hello')).content, 'answered by worker-model');
      assert.strictEqual((await adapter.execute(custom('smart'), 'hello')).content, 'answered by main-model');
      assert.strictEqual((await adapter.execute(agent('code-explorer'), 'hello', { role: 'main' })).content, 'answered by main-model');
      assert.deepStrictEqual(used, ['main-model', 'worker-model', 'utility-model', 'worker-model', 'main-model', 'main-model']);
    } finally {
      await core.shutdown();
    }
  });

  it('a named model is an explicit target; a provider with no model takes the profile\'s model of it', async () => {
    const { core, used, adapter } = await startCore({ main: [t(FAKE, 'main-model')], worker: [t(FAKE, 'worker-model')] });
    try {
      await adapter.execute(agent('code-explorer'), 'hello', { model: 'named-model' });
      await adapter.execute(agent('code-explorer'), 'hello', { provider: FAKE });
      assert.deepStrictEqual(used, ['named-model', 'worker-model']);
      await assert.rejects(adapter.execute(agent('main'), 'hello', { provider: 'groq' }), /No groq model is in the profile "Test profile"/);
    } finally {
      await core.shutdown();
    }
  });

  it('a model a sub-agent names must already be in the profile (M-D2)', async () => {
    const { core, used, adapter } = await startCore({ main: [t(FAKE, 'main-model')], worker: [t(FAKE, 'worker-model')], utility: [t(FAKE, 'utility-model')] });
    try {
      // In the profile, by bare id or provider/model: it runs, whichever role holds it.
      await adapter.execute(agent('code-explorer'), 'hello', { model: 'utility-model', requireInProfile: true });
      await adapter.execute(agent('code-explorer'), 'hello', { model: `${FAKE}/main-model`, requireInProfile: true });
      assert.deepStrictEqual(used, ['utility-model', 'main-model']);
      await assert.rejects(
        adapter.execute(agent('code-explorer'), 'hello', { model: 'named-model', requireInProfile: true }),
        (err) => err.code === 'MODEL_NOT_IN_PROFILE'
          && /named-model is not in the profile "Test profile"/.test(err.message)
          && err.message.includes(`${FAKE}/worker-model`)
      );
      assert.deepStrictEqual(used, ['utility-model', 'main-model'], 'a refused model is never called');
    } finally {
      await core.shutdown();
    }
  });

  it('a role the profile does not define fails naming the role', async () => {
    const { core, adapter } = await startCore({ main: [t(FAKE, 'main-model')] });
    try {
      await assert.rejects(adapter.execute(agent('main'), 'hello', { role: 'legal-drafting' }), /Unknown model role "legal-drafting"/);
    } finally {
      await core.shutdown();
    }
  });

  it('a failing first target fails over to the next one in the role', async () => {
    const { core, used, adapter } = await startCore({ worker: [t(FAKE, 'down'), t(FAKE, 'backup')], main: [t(FAKE, 'main-model')] });
    // code-explorer runs on worker.
    try {
      assert.strictEqual((await adapter.execute(agent('code-explorer'), 'hello')).content, 'answered by backup');
      assert.deepStrictEqual(used, ['down', 'backup']);
    } finally {
      await core.shutdown();
    }
  });

  it('createAgentRuntime returns the role, its first model and a routed provider', async () => {
    const { core } = await startCore({ main: [t(FAKE, 'main-model')] });
    try {
      const rt = await core.context.createAgentRuntime({ role: 'utility' });
      assert.deepStrictEqual([rt.role, rt.providerType, rt.model, rt.timeoutMs], ['utility', FAKE, 'main-model', 15000]);
      assert.strictEqual(rt.provider.routed, true);
      assert.strictEqual('tier' in rt, false);
    } finally {
      await core.shutdown();
    }
  });

  it('fails before any call when the role has no usable model, with the reasons', async () => {
    const { core, used, adapter } = await startCore({ main: [t('groq', 'llama-3.3-70b-versatile')] });
    try {
      await assert.rejects(adapter.execute(agent('planner'), 'hello'), /No usable model for main.*groq\/llama-3\.3-70b-versatile \(No token saved for Groq\.\)/);
      assert.deepStrictEqual(used, []);
    } finally {
      await core.shutdown();
    }
  });
});
