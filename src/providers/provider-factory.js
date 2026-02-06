const OpenAIProvider = require('./openai-provider');
const AnthropicProvider = require('./anthropic-provider');

class ProviderFactory {
  static createProvider(providerType, apiKey) {
    switch (providerType) {
      case 'openai':
        return new OpenAIProvider(apiKey);
      case 'anthropic':
        return new AnthropicProvider(apiKey);
      default:
        throw new Error(`Unknown or unsupported provider for chat: ${providerType}`);
    }
  }
}

module.exports = ProviderFactory;