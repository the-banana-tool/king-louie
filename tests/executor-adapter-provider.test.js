// tests/executor-adapter-provider.test.js
// Cases stage 2 spec §3.8 defect 1: a workflow-style execute with
// options.provider must run on that provider, not the active tier's.
const { describe, it, after } = require('node:test');
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

const tempDirs = [];
after(() => { while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true }); });

describe('agent executor adapter', () => {
  it('runs on options.provider and options.model while the active tier maps to another provider', async () => {
    const used = [];
    const stub = (name) => class {
      constructor(apiKey) { this.apiKey = apiKey; }
      getProviderName() { return name; }
      getDefaultModel() { return `${name}-default`; }
      async sendMessage() { used.push([name, 'sendMessage']); return `from ${name}`; }
      async sendMessageWithTools(messages, tools, options) { used.push([name, options.model]); return { type: 'text', content: `from ${name}` }; }
    };
    const saved = { openai: ProviderFactory._registry.get('openai'), groq: ProviderFactory._registry.get('groq') };
    ProviderFactory.registerProvider('openai', stub('openai'));
    ProviderFactory.registerProvider('groq', stub('groq'));

    const savedEnv = process.env.KL_CASES_ROOT;
    delete process.env.KL_CASES_ROOT;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-adapter-'));
    tempDirs.push(dataDir);
    const store = new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } });
    store.set('settings', { activeProvider: 'groq', inference: { activeTier: 'standard', tierMap: { standard: { provider: 'groq', model: 'groq-model' } } } });
    const core = createCore({
      paths: { dataDir },
      store,
      vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
      cipher: createAesGcmCipher(crypto.randomBytes(32)),
      prompter: createHeadlessPrompter(),
      builtinSkillsDir: path.join(__dirname, '..', 'skills'),
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false }
    });
    try {
      // Tokens are saved after start(), not before: createCore snapshots
      // getDecryptedProviderToken('openai') once during start() to decide
      // whether to build a real embedding provider for the context
      // assembler's background indexing. Saving the fake key first would
      // make that indexing step try a real (and here, doomed) network call
      // (M1). Every other use of these tokens (including this test's own
      // adapter.execute) reads them fresh, so saving them after start()
      // changes nothing else.
      await core.start();
      core.saveProviderToken('openai', 'sk-test-openai');
      core.saveProviderToken('groq', 'gsk-test-groq');
      const adapter = core.context.getCronScheduler().executor.agentExecutor;
      const agent = listAgents().find((a) => a.id === 'main');
      const result = await adapter.execute(agent, 'Summarise the lot listing.', { provider: 'openai', model: 'gpt-stub' });
      assert.strictEqual(result.content, 'from openai');
      assert.deepStrictEqual(used, [['openai', 'gpt-stub']]);
    } finally {
      await core.shutdown();
      ProviderFactory.registerProvider('openai', saved.openai);
      ProviderFactory.registerProvider('groq', saved.groq);
      if (savedEnv === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = savedEnv;
    }
  });
});
