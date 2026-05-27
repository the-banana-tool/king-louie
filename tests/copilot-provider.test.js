const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert');

describe('CopilotProvider', () => {
  let CopilotProvider;
  let ProviderFactory;
  let originalFetch;

  before(() => {
    CopilotProvider = require('../src/providers/copilot-provider');
    ProviderFactory = require('../src/providers/provider-factory');
  });

  afterEach(() => { global.fetch = originalFetch; });

  it('instantiates with a GitHub token', () => {
    const provider = new CopilotProvider('ghp_testtoken1234567890');
    assert.strictEqual(provider.getName(), 'copilot');
    assert.strictEqual(provider.getLabel(), 'GitHub Copilot');
    assert.strictEqual(provider.getDefaultModel(), 'gpt-4o');
  });

  it('is registered in ProviderFactory', () => {
    const provider = ProviderFactory.createProvider('copilot', 'ghp_testtoken1234567890');
    assert.ok(provider instanceof CopilotProvider);
  });

  it('exchanges the GitHub token for a Copilot session token and caches it', async () => {
    originalFetch = global.fetch;
    let exchangeCalls = 0;
    global.fetch = async (url, opts) => {
      if (String(url).includes('copilot_internal/v2/token')) {
        exchangeCalls++;
        assert.match(opts.headers.Authorization, /^token ghp_/);
        return { ok: true, json: async () => ({ token: 'copilot-session-tok', expires_at: Math.floor(Date.now() / 1000) + 1800 }) };
      }
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'hi' } }], usage: {} }) };
    };

    const provider = new CopilotProvider('ghp_testtoken1234567890');
    await provider.sendMessage([{ role: 'user', content: 'hello' }]);
    await provider.sendMessage([{ role: 'user', content: 'again' }]);

    assert.strictEqual(exchangeCalls, 1, 'session token should be cached across calls');
  });

  it('sends Copilot-required headers + an OpenAI-compatible body', async () => {
    originalFetch = global.fetch;
    let chatOpts = null;
    global.fetch = async (url, opts) => {
      if (String(url).includes('copilot_internal/v2/token')) {
        return { ok: true, json: async () => ({ token: 'sess', expires_at: Math.floor(Date.now() / 1000) + 1800 }) };
      }
      chatOpts = opts;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }) };
    };

    const provider = new CopilotProvider('ghp_testtoken1234567890');
    await provider.sendMessageWithTools(
      [{ role: 'user', content: 'hi' }],
      [{ name: 'do_thing', description: 'd', parameters: { type: 'object', properties: {} } }],
      {}
    );

    assert.strictEqual(chatOpts.headers.Authorization, 'Bearer sess');
    assert.strictEqual(chatOpts.headers['Copilot-Integration-Id'], 'vscode-chat');
    const body = JSON.parse(chatOpts.body);
    assert.strictEqual(body.tools[0].function.name, 'do_thing');
    assert.strictEqual(body.model, 'gpt-4o');
  });

  it('surfaces a clear error when Copilot is not enabled for the account', async () => {
    originalFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({}) }); // no token field

    const provider = new CopilotProvider('ghp_testtoken1234567890');
    await assert.rejects(
      () => provider.sendMessage([{ role: 'user', content: 'hi' }]),
      /Copilot.*no token|is Copilot enabled/i
    );
  });

  it('propagates token-exchange auth failures', async () => {
    originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: false, status: 401, statusText: 'Unauthorized',
      json: async () => ({ message: 'Bad credentials' })
    });

    const provider = new CopilotProvider('ghp_badtoken1234567890');
    await assert.rejects(() => provider.sendMessage([{ role: 'user', content: 'hi' }]), /Bad credentials/);
  });
});
