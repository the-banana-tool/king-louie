const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const BaseLLMProvider = require('../src/providers/base-provider');

describe('ProviderFactory', () => {
  // Import fresh each time to avoid registry pollution between tests
  let ProviderFactory;

  beforeEach(() => {
    // Clear module cache to get a fresh registry
    delete require.cache[require.resolve('../src/providers/provider-factory')];
    ProviderFactory = require('../src/providers/provider-factory');
  });

  it('registers and creates a provider', () => {
    class MockProvider {
      constructor(apiKey) { this.apiKey = apiKey; }
    }
    ProviderFactory.registerProvider('mock', MockProvider);
    const instance = ProviderFactory.create('mock', 'test');
    assert.ok(instance instanceof MockProvider);
    assert.strictEqual(instance.apiKey, 'test');
  });

  it('lists registered providers', () => {
    class A {}
    class B {}
    ProviderFactory.registerProvider('alpha', A);
    ProviderFactory.registerProvider('beta', B);
    const list = ProviderFactory.listRegistered();
    assert.ok(list.includes('alpha'));
    assert.ok(list.includes('beta'));
  });

  it('throws on unknown provider with helpful message', () => {
    assert.throws(
      () => ProviderFactory.create('nonexistent', 'test-key'),
      /Unknown provider.*nonexistent/
    );
  });

  it('is case-insensitive for provider type', () => {
    class MockProvider {}
    ProviderFactory.registerProvider('MyProvider', MockProvider);
    const instance = ProviderFactory.create('myprovider', 'test-key');
    assert.ok(instance instanceof MockProvider);
  });

  it('rejects invalid providerType', () => {
    assert.throws(
      () => ProviderFactory.registerProvider('', class {}),
      /non-empty string/
    );
    assert.throws(
      () => ProviderFactory.registerProvider(null, class {}),
      /non-empty string/
    );
  });

  it('rejects non-constructor ProviderClass', () => {
    assert.throws(
      () => ProviderFactory.registerProvider('test', 'not-a-class'),
      /constructor/
    );
  });

  it('includes openai and anthropic by default', () => {
    const list = ProviderFactory.listRegistered();
    assert.ok(list.includes('openai'));
    assert.ok(list.includes('anthropic'));
  });

  it('create() produces working OpenAI provider', () => {
    const provider = ProviderFactory.create('openai', 'sk-test12345'); // valid length for base provider
    assert.ok(provider);
    assert.ok(typeof provider.getModels === 'function');
  });

  it('createProvider() produces working Anthropic provider (backward compatibility)', () => {
    const provider = ProviderFactory.createProvider('anthropic', 'sk-test12345');
    assert.ok(provider);
    assert.ok(typeof provider.getModels === 'function');
  });
});

describe('BaseLLMProvider.discoverModels', () => {
  it('returns model list with capabilities by default', async () => {
    class TestProvider extends BaseLLMProvider {
      getModels() { return ['model-a', 'model-b']; }
    }
    const provider = new TestProvider('test-key123'); // API key must be 8+ chars
    const models = await provider.discoverModels();
    assert.strictEqual(models.length, 2);
    assert.strictEqual(models[0].id, 'model-a');
    assert.ok(models[0].capabilities.includes('chat'));
  });
});
