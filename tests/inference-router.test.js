const { describe, it } = require('node:test');
const assert = require('node:assert');
const InferenceRouter = require('../src/providers/inference-router');

describe('InferenceRouter', () => {
  const mockConfig = (overrides = {}) => {
    const defaultSettings = {
      inference: {
        tierMap: {
          fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
          standard: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' },
          smart: { provider: 'anthropic', model: 'claude-3-5-sonnet-latest' }
        },
        activeTier: 'standard'
      },
      activeProvider: 'openai'
    };

    return {
      getSettings: () => ({ ...defaultSettings, ...overrides.settings }),
      getProviderModel: (p) => overrides.models?.[p] || '',
      getProviderToken: (p) => 'fake-token',
      createProvider: (p, t) => overrides.providers?.[p] || {
        getDefaultModel: () => 'default-model',
        sendMessage: async () => `response from ${p}`,
        sendMessageWithTools: async () => `tool response from ${p}`
      }
    };
  };

  it('resolves fast tier to groq', () => {
    const router = new InferenceRouter(mockConfig());
    const resolved = router.getTierConfig('fast');
    assert.strictEqual(resolved.provider, 'groq');
    assert.strictEqual(resolved.model, 'llama-3.3-70b-versatile');
  });

  it('falls back when primary provider fails', async () => {
    let openaiCalled = false;
    let groqCalled = false;

    const router = new InferenceRouter(mockConfig({
      providers: {
        groq: {
          getDefaultModel: () => 'llama-3.3',
          sendMessage: async () => {
            groqCalled = true;
            throw new Error('Groq failed');
          }
        },
        openai: {
          getDefaultModel: () => 'gpt-4o-mini',
          sendMessage: async () => {
            openaiCalled = true;
            return 'openai response';
          }
        }
      }
    }));

    const result = await router.routeWithFallback('fast', [{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(groqCalled, true);
    assert.strictEqual(openaiCalled, true);
    assert.strictEqual(result, 'openai response');
  });

  it('throws when no fallback available', async () => {
    const router = new InferenceRouter(mockConfig({
      providers: {
        anthropic: {
          getDefaultModel: () => 'claude-3',
          sendMessage: async () => {
            throw new Error('Anthropic failed');
          }
        }
      }
    }));

    await assert.rejects(
      async () => router.routeWithFallback('standard', [{ role: 'user', content: 'hi' }], {}),
      /Anthropic failed/
    );
  });

  it('returns capabilities for known models', () => {
    const router = new InferenceRouter(mockConfig());
    const caps = router.getCapabilities('openai', 'gpt-4o');
    assert.strictEqual(caps.vision, true);
    assert.strictEqual(caps.toolCalling, true);
  });

  it('all new providers are valid tier options', () => {
    const providers = ['groq', 'ollama', 'mistral', 'gemini', 'openrouter'];

    for (const p of providers) {
      const router = new InferenceRouter(mockConfig({
        settings: {
          inference: {
            tierMap: { fast: { provider: p, model: 'test-model' } }
          }
        }
      }));
      const resolved = router.getTierConfig('fast');
      assert.strictEqual(resolved.provider, p);
      assert.strictEqual(resolved.model, 'test-model');
    }
  });

  it('resolves Ollama as active provider without a real token', () => {
    const router = new InferenceRouter(mockConfig({
      settings: {
        activeProvider: 'ollama',
        inference: {
          tierMap: {},
          activeTier: 'standard'
        }
      }
    }));
    const resolved = router.resolve({});
    assert.strictEqual(resolved.providerType, 'ollama');
  });

  it('resolves Ollama with dummy token from getProviderToken', () => {
    const router = new InferenceRouter({
      getSettings: () => ({
        activeProvider: 'ollama',
        inference: { tierMap: {}, activeTier: 'standard' }
      }),
      getProviderModel: () => 'llama3',
      getProviderToken: (p) => {
        if (p === 'ollama') return 'not-required';
        throw new Error(`No token for ${p}`);
      },
      createProvider: (p, t) => ({
        getDefaultModel: () => 'llama3',
        sendMessage: async () => `response from ${p}`
      })
    });
    const resolved = router.resolve({});
    assert.strictEqual(resolved.providerType, 'ollama');
    assert.strictEqual(resolved.model, 'llama3');
    assert.ok(resolved.provider);
  });

  it('executes chat through Ollama provider', async () => {
    let receivedToken = null;
    const router = new InferenceRouter({
      getSettings: () => ({
        activeProvider: 'ollama',
        inference: {
          tierMap: { standard: { provider: 'ollama', model: 'llama3' } },
          activeTier: 'standard'
        }
      }),
      getProviderModel: () => '',
      getProviderToken: (p) => {
        if (p === 'ollama') return 'not-required';
        throw new Error(`No token for ${p}`);
      },
      createProvider: (p, t) => {
        receivedToken = t;
        return {
          getDefaultModel: () => 'llama3',
          sendMessage: async () => 'ollama says hi'
        };
      }
    });

    const result = await router.routeWithFallback('standard', [{ role: 'user', content: 'hi' }], {});
    assert.strictEqual(result, 'ollama says hi');
    assert.strictEqual(receivedToken, 'not-required');
  });
});
