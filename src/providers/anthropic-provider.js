const BaseLLMProvider = require('./base-provider');

class AnthropicProvider extends BaseLLMProvider {
  getDefaultModel() {
    return 'claude-3-5-sonnet-latest';
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01'
    };
  }

  formatMessages(chatHistory) {
    return this.normalizeMessages(chatHistory)
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg) => ({
        role: msg.role,
        content: msg.content
      }));
  }

  async sendMessage(messages, options = {}) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || this.getDefaultModel(),
        messages: this.formatMessages(messages),
        max_tokens: options.max_tokens || 4096,
        temperature: options.temperature ?? 0.7,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const data = await response.json();
    return (data.content || [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('');
  }

  async streamMessage(messages, options = {}, onChunk) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || this.getDefaultModel(),
        messages: this.formatMessages(messages),
        max_tokens: options.max_tokens || 4096,
        temperature: options.temperature ?? 0.7,
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const content = parsed?.delta?.text || parsed?.content_block?.text;
          if (content) onChunk(content);
        } catch {
          // Ignore malformed partial chunks
        }
      }
    }
  }

  async listModels() {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: this.getHeaders()
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const data = await response.json();
    return (data.data || []).map((model) => model.id).sort();
  }

  async extractError(response) {
    try {
      const body = await response.json();
      return body?.error?.message || `${response.status} ${response.statusText}`;
    } catch {
      return `${response.status} ${response.statusText}`;
    }
  }
}

module.exports = AnthropicProvider;