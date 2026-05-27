const OpenAIProvider = require('./openai-provider');
const AnthropicProvider = require('./anthropic-provider');
const GroqProvider = require('./groq-provider');
const MistralProvider = require('./mistral-provider');
const OllamaProvider = require('./ollama-provider');
const GeminiProvider = require('./gemini-provider');
const OpenRouterProvider = require('./openrouter-provider');
const XAIProvider = require('./xai-provider');
const DeepSeekProvider = require('./deepseek-provider');
const QwenProvider = require('./qwen-provider');
const TogetherProvider = require('./together-provider');
const FireworksProvider = require('./fireworks-provider');
const CohereProvider = require('./cohere-provider');
const CopilotProvider = require('./copilot-provider');

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

  static create(providerType, apiKey, options = {}) {
    const key = (providerType || '').toLowerCase();
    const ProviderClass = ProviderFactory._registry.get(key);
    if (!ProviderClass) {
      const available = ProviderFactory.listRegistered().join(', ');
      throw new Error(`Unknown provider: "${providerType}". Available: ${available}`);
    }
    return new ProviderClass(apiKey, options);
  }

  static createProvider(providerType, apiKey, options = {}) {
    return ProviderFactory.create(providerType, apiKey, options);
  }
}

ProviderFactory.registerProvider('openai', OpenAIProvider);
ProviderFactory.registerProvider('anthropic', AnthropicProvider);
ProviderFactory.registerProvider('groq', GroqProvider);
ProviderFactory.registerProvider('mistral', MistralProvider);
ProviderFactory.registerProvider('ollama', OllamaProvider);
ProviderFactory.registerProvider('gemini', GeminiProvider);
ProviderFactory.registerProvider('openrouter', OpenRouterProvider);
ProviderFactory.registerProvider('xai', XAIProvider);
ProviderFactory.registerProvider('deepseek', DeepSeekProvider);
ProviderFactory.registerProvider('qwen', QwenProvider);
ProviderFactory.registerProvider('together', TogetherProvider);
ProviderFactory.registerProvider('fireworks', FireworksProvider);
ProviderFactory.registerProvider('cohere', CohereProvider);
ProviderFactory.registerProvider('copilot', CopilotProvider);

module.exports = ProviderFactory;
