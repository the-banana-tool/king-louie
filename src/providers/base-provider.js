class BaseLLMProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.validateApiKey();
  }

  validateApiKey() {
    if (!this.apiKey || typeof this.apiKey !== 'string' || this.apiKey.trim().length < 8) {
      throw new Error('Invalid API key');
    }
  }

  normalizeMessages(chatHistory = []) {
    return chatHistory
      .map((msg) => {
        if (msg.role && msg.content) {
          return { role: msg.role, content: msg.content };
        }

        if (msg.sender && typeof msg.text === 'string') {
          return {
            role: msg.sender === 'assistant' ? 'assistant' : 'user',
            content: msg.text
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  formatMessages(chatHistory) {
    return this.normalizeMessages(chatHistory);
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`
    };
  }

  getDefaultModel() {
    throw new Error('getDefaultModel must be implemented by provider');
  }

  async sendMessage() {
    throw new Error('sendMessage must be implemented by provider');
  }

  async streamMessage() {
    throw new Error('streamMessage must be implemented by provider');
  }

  async listModels() {
    throw new Error('listModels must be implemented by provider');
  }
}

module.exports = BaseLLMProvider;