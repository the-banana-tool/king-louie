const { describe, it } = require('node:test');
const assert = require('node:assert');
const LLMRouter = require('../src/providers/llm-router');

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRouter(overrides = {}) {
  return new LLMRouter({
    getSettings: () => ({
      inference: {
        llmRouting: {
          enabled: true,
          costSensitivity: 'medium',
          speedPriority: 'medium',
          qualityPriority: 'high',
          ...(overrides.llmRouting || {})
        }
      }
    }),
    getProviderToken: (provider) => {
      const tokens = { openai: 'sk-test', anthropic: 'sk-ant-test', groq: 'gsk-test', gemini: 'gm-test', ...(overrides.tokens || {}) };
      return tokens[provider] || null;
    },
    createProvider: (provider, token) => ({
      providerName: provider,
      sendMessage: async (messages, options) => {
        const response = overrides.classifierResponse || '{"provider": "anthropic", "model": "claude-sonnet-4-20250514", "reason": "coding task"}';
        return response;
      }
    }),
    ...(overrides.constructorOverrides || {})
  });
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('LLMRouter', () => {
  describe('getAvailableModels()', () => {
    it('returns models for providers that have tokens', () => {
      const router = makeRouter();
      const models = router.getAvailableModels();
      assert.ok(Object.keys(models).length > 0);
      assert.ok('openai:gpt-4o' in models);
      assert.ok('anthropic:claude-sonnet-4-20250514' in models);
    });

    it('excludes providers without tokens', () => {
      const router = makeRouter({ tokens: { openai: 'sk-test' } });
      const models = router.getAvailableModels();
      assert.ok('openai:gpt-4o' in models);
      assert.ok(!('xai:grok-3' in models));
    });

    it('returns empty when no providers have tokens', () => {
      const router = makeRouter({
        constructorOverrides: {
          getProviderToken: () => null
        }
      });
      const models = router.getAvailableModels();
      assert.strictEqual(Object.keys(models).length, 0);
    });
  });

  describe('buildModelList()', () => {
    it('formats model capabilities into a readable string', () => {
      const router = makeRouter();
      const models = { 'openai:gpt-4o': { strengths: ['coding', 'vision'], speed: 'medium', cost: 'medium', context: '128k' } };
      const list = router.buildModelList(models);
      assert.ok(list.includes('openai:gpt-4o'));
      assert.ok(list.includes('coding'));
      assert.ok(list.includes('speed=medium'));
    });
  });

  describe('getCacheKey()', () => {
    it('normalizes messages for caching', () => {
      const router = makeRouter();
      const key1 = router.getCacheKey('Hello World');
      const key2 = router.getCacheKey('hello world');
      assert.strictEqual(key1, key2);
    });

    it('truncates long messages', () => {
      const router = makeRouter();
      const longMsg = 'a'.repeat(500);
      const key = router.getCacheKey(longMsg);
      assert.ok(key.length < 300);
    });
  });

  describe('classify()', () => {
    it('returns provider and model from classifier response', async () => {
      const router = makeRouter({
        classifierResponse: '{"provider": "openai", "model": "gpt-4o", "reason": "vision task"}'
      });

      const result = await router.classify('Analyze this image for me');
      assert.strictEqual(result.provider, 'openai');
      assert.strictEqual(result.model, 'gpt-4o');
      assert.strictEqual(result.reason, 'vision task');
    });

    it('caches classification results', async () => {
      let callCount = 0;
      const router = makeRouter({
        constructorOverrides: {
          createProvider: () => ({
            sendMessage: async () => {
              callCount++;
              return '{"provider": "openai", "model": "gpt-4o", "reason": "test"}';
            }
          })
        }
      });

      await router.classify('Test message');
      await router.classify('Test message');
      assert.strictEqual(callCount, 1);
    });

    it('returns null when no providers have tokens', async () => {
      const router = makeRouter({
        constructorOverrides: {
          getProviderToken: () => null
        }
      });
      const result = await router.classify('Test');
      assert.strictEqual(result, null);
    });

    it('returns null when LLM routing is disabled', async () => {
      const router = new LLMRouter({
        getSettings: () => ({ inference: { llmRouting: { enabled: false } } }),
        getProviderToken: () => 'token',
        createProvider: () => ({ sendMessage: async () => '{}' })
      });
      const result = await router.classify('Test');
      assert.strictEqual(result, null);
    });

    it('returns null when classifier returns invalid JSON', async () => {
      const router = makeRouter({ classifierResponse: 'not json' });
      const result = await router.classify('Test');
      assert.strictEqual(result, null);
    });

    it('returns null when classifier returns incomplete response', async () => {
      const router = makeRouter({ classifierResponse: '{"provider": "openai"}' });
      const result = await router.classify('Test');
      assert.strictEqual(result, null);
    });

    it('returns null when selected model is not available', async () => {
      const router = makeRouter({
        classifierResponse: '{"provider": "xai", "model": "grok-3", "reason": "fast"}',
        tokens: { openai: 'sk-test' } // xai not available
      });
      const result = await router.classify('Test');
      assert.strictEqual(result, null);
    });

    it('evicts oldest cache entry when max size is reached', async () => {
      const router = makeRouter({
        classifierResponse: '{"provider": "openai", "model": "gpt-4o", "reason": "test"}'
      });
      router.cacheMaxSize = 3;

      await router.classify('Message 1');
      await router.classify('Message 2');
      await router.classify('Message 3');
      assert.strictEqual(router.cache.size, 3);

      await router.classify('Message 4');
      assert.strictEqual(router.cache.size, 3);
    });
  });
});
