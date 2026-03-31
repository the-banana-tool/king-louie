const BaseLLMProvider = require('./base-provider');

class CohereProvider extends BaseLLMProvider {
  constructor(apiKey) {
    super(apiKey);
    this.baseUrl = 'https://api.cohere.com/v2';
  }

  getName() { return 'cohere'; }
  getLabel() { return 'Cohere'; }
  getProviderName() { return 'cohere'; }

  getModels() {
    return [
      { id: 'command-r-plus', name: 'Command R+', contextWindow: 131072 },
      { id: 'command-r', name: 'Command R', contextWindow: 131072 },
      { id: 'command-a-03-2025', name: 'Command A', contextWindow: 262144 }
    ];
  }

  getDefaultModel() { return 'command-r-plus'; }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`
    };
  }

  prependSystemPrompt(messages = [], systemPrompt = '') {
    if (!systemPrompt || typeof systemPrompt !== 'string') return messages;
    return [{ role: 'system', content: systemPrompt }, ...(messages || [])];
  }

  formatMessages(chatHistory) {
    return (chatHistory || [])
      .map((msg) => {
        if (!msg) return null;
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
          return { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls };
        }
        if (msg.role === 'tool') {
          return { role: 'tool', tool_call_id: msg.tool_call_id, content: msg.content || '' };
        }
        if (msg.role && typeof msg.content === 'string') {
          return { role: msg.role, content: msg.content };
        }
        if (msg.sender && typeof msg.text === 'string') {
          return { role: msg.sender === 'assistant' ? 'assistant' : 'user', content: msg.text };
        }
        return null;
      })
      .filter(Boolean);
  }

  async sendMessage(messages, options = {}) {
    const preparedMessages = this.prependSystemPrompt(messages, options.systemPrompt);
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || this.getDefaultModel(),
        messages: this.formatMessages(preparedMessages),
        temperature: options.temperature ?? 0.7,
        stream: false
      })
    });
    if (!response.ok) throw new Error(await this.extractError(response));
    const data = await response.json();
    return data.message?.content?.[0]?.text || '';
  }

  async sendMessageWithTools(messages, tools = [], options = {}) {
    const requestedModel = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, options.systemPrompt);
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        messages: this.formatMessages(preparedMessages),
        tools: tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters }
        })),
        temperature: options.temperature ?? 0.7,
        stream: false
      })
    });
    if (!response.ok) throw new Error(await this.extractError(response));
    const data = await response.json();
    const llmMetrics = this.buildLlmCallMetrics({ model: data.model || requestedModel, usage: data.usage });
    return this.parseToolResponse(data, llmMetrics);
  }

  parseToolResponse(response, llmMetrics) {
    const message = response?.message;
    if (!message) return { type: 'text', content: '', llmMetrics };

    const toolCall = message.tool_calls?.[0];
    if (toolCall?.function?.name) {
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(toolCall.function.arguments || '{}'); } catch { parsedArgs = {}; }
      return { type: 'tool_use', toolName: toolCall.function.name, toolUseId: toolCall.id, parameters: parsedArgs, messageContent: message.content?.[0]?.text || '', llmMetrics };
    }

    return { type: 'text', content: message.content?.[0]?.text || '', llmMetrics };
  }

  buildToolMessages(response, toolResult, toolCallId) {
    return [
      { role: 'assistant', content: response.messageContent || '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: JSON.stringify(response.parameters || {}) } }] },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ];
  }

  async streamMessage(messages, options = {}, onChunk) {
    const requestedModel = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, options.systemPrompt);
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        messages: this.formatMessages(preparedMessages),
        temperature: options.temperature ?? 0.7,
        stream: true
      })
    });
    if (!response.ok) throw new Error(await this.extractError(response));

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    let model = requestedModel;
    const buildResult = () => ({ llmMetrics: this.buildLlmCallMetrics({ model, usage }) });

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
        if (data === '[DONE]') return buildResult();
        try {
          const parsed = JSON.parse(data);
          if (parsed?.type === 'content-delta') {
            const text = parsed.delta?.message?.content?.text;
            if (text) onChunk(text);
          }
          if (parsed?.type === 'message-end' && parsed?.delta?.usage) {
            usage = {
              prompt_tokens: parsed.delta.usage.billed_units?.input_tokens || 0,
              completion_tokens: parsed.delta.usage.billed_units?.output_tokens || 0
            };
          }
        } catch { /* ignore partial chunks */ }
      }
    }
    return buildResult();
  }

  async listModels() {
    const response = await fetch('https://api.cohere.com/v1/models', { method: 'GET', headers: this.getHeaders() });
    if (!response.ok) throw new Error(await this.extractError(response));
    const data = await response.json();
    return (data.models || []).map((m) => m.name).sort();
  }

  async extractError(response) {
    try {
      const body = await response.json();
      return body?.message || `${response.status} ${response.statusText}`;
    } catch { return `${response.status} ${response.statusText}`; }
  }
}

module.exports = CohereProvider;
