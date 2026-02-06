const BaseLLMProvider = require('./base-provider');

class OpenAIProvider extends BaseLLMProvider {
  getDefaultModel() {
    return 'gpt-4o-mini';
  }

  getHeaders() {
    return {
      ...super.getHeaders()
    };
  }

  formatMessages(chatHistory) {
    return this.normalizeMessages(chatHistory);
  }

  async sendMessage(messages, options = {}) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || this.getDefaultModel(),
        messages: this.formatMessages(messages),
        temperature: options.temperature ?? 0.7,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async streamMessage(messages, options = {}, onChunk) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || this.getDefaultModel(),
        messages: this.formatMessages(messages),
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
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) onChunk(content);
        } catch {
          // Ignore malformed partial chunks
        }
      }
    }
  }

  async listModels() {
    const response = await fetch('https://api.openai.com/v1/models', {
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

module.exports = OpenAIProvider;