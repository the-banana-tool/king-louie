const OpenAIProvider = require('./openai-provider');
const AnthropicProvider = require('./anthropic-provider');
const GroqProvider = require('./groq-provider');

class ProviderFactory {
  static _registry = new Map();

  static registerProvider(providerType, ProviderClass) {
    if (typeof providerType !== 'string' || !providerType) {
      throw new Error('providerType must be a non-empty string');
    }
    if (typeof ProviderClass !== 'function') {
      throw new Error('ProviderClass must be a constructor');
    }
    ProviderFactory._registry.set(providerType.toLowerCase(), ProviderClass);
  }

  static listRegistered() {
    return Array.from(ProviderFactory._registry.keys());
  }

  static create(providerType, apiKey) {
    const key = (providerType || '').toLowerCase();
    const ProviderClass = ProviderFactory._registry.get(key);
    if (!ProviderClass) {
      const available = ProviderFactory.listRegistered().join(', ');
      throw new Error(`Unknown provider: "${providerType}". Available: ${available}`);
    }
    return new ProviderClass(apiKey);
  }

  static createProvider(providerType, apiKey) {
    return ProviderFactory.create(providerType, apiKey);
  }
}

ProviderFactory.registerProvider('openai', OpenAIProvider);
ProviderFactory.registerProvider('anthropic', AnthropicProvider);

module.exports = ProviderFactory;
