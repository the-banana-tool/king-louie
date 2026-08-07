const BaseLLMProvider = require('./base-provider');

class DeepSeekProvider extends BaseLLMProvider {
  constructor(apiKey) {
    super(apiKey);
    this.baseUrl = 'https://api.deepseek.com/v1';
  }

  getName() { return 'deepseek'; }
  getLabel() { return 'DeepSeek'; }
  getProviderName() { return 'deepseek'; }

  getModels() {
    return [
      { id: 'deepseek-chat', name: 'DeepSeek V3', contextWindow: 65536 },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', contextWindow: 65536 }
    ];
  }

  getDefaultModel() { return 'deepseek-chat'; }

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
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || this.getDefaultModel(),
        messages: this.formatMessages(preparedMessages),
        temperature: options.temperature ?? 0.7,
        stream: false
      })
    });
    if (!response.ok) throw await this.buildError(response);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async sendMessageWithTools(messages, tools = [], options = {}) {
    const requestedModel = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, options.systemPrompt);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        messages: this.formatMessages(preparedMessages),
        tools: tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters }
        })),
        tool_choice: 'auto',
        temperature: options.temperature ?? 0.7,
        stream: false
      })
    });
    if (!response.ok) throw await this.buildError(response);
    const data = await response.json();
    const llmMetrics = this.buildLlmCallMetrics({ model: data.model || requestedModel, usage: data.usage });
    return this.parseToolResponse(data, llmMetrics);
  }

  parseToolResponse(response, llmMetrics) {
    const message = response?.choices?.[0]?.message;
    if (!message) return { type: 'text', content: '', llmMetrics };
    const functionCalls = (message.tool_calls || []).filter((call) => call.type === 'function' && call.function?.name);
    if (functionCalls.length > 0) {
      const toolCalls = functionCalls.map((call) => {
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(call.function.arguments || '{}'); } catch { parsedArgs = {}; }
        return { toolName: call.function.name, toolUseId: call.id, parameters: parsedArgs };
      });
      return { type: 'tool_use', toolName: toolCalls[0].toolName, toolUseId: toolCalls[0].toolUseId, parameters: toolCalls[0].parameters, toolCalls, messageContent: message.content || '', llmMetrics };
    }
    return { type: 'text', content: message.content || '', llmMetrics };
  }

  buildToolMessages(response, toolResult, toolCallId) {
    return [
      { role: 'assistant', content: response.messageContent || '', tool_calls: [{ id: toolCallId, type: 'function', function: { name: response.toolName, arguments: JSON.stringify(response.parameters || {}) } }] },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ];
  }

  buildMultiToolMessages(response, toolCallEntries) {
    const messages = [{ role: 'assistant', content: response.messageContent || '', tool_calls: toolCallEntries.map((e) => ({ id: e.toolCallId, type: 'function', function: { name: e.toolName, arguments: JSON.stringify(e.parameters || {}) } })) }];
    for (const e of toolCallEntries) messages.push({ role: 'tool', tool_call_id: e.toolCallId, content: JSON.stringify(e.result) });
    return messages;
  }

  async streamMessage(messages, options = {}, onChunk) {
    const requestedModel = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, options.systemPrompt);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        messages: this.formatMessages(preparedMessages),
        temperature: options.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true }
      })
    });
    if (!response.ok) throw await this.buildError(response);

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
          if (parsed?.usage) usage = parsed.usage;
          if (parsed?.model) model = parsed.model;
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) onChunk(content);
        } catch { /* ignore partial chunks */ }
      }
    }
    return buildResult();
  }

  async listModels() {
    const response = await fetch(`${this.baseUrl}/models`, { method: 'GET', headers: this.getHeaders() });
    if (!response.ok) throw await this.buildError(response);
    const data = await response.json();
    return (data.data || []).map((m) => m.id).sort();
  }

  async extractError(response) {
    try {
      const body = await response.json();
      return body?.error?.message || `${response.status} ${response.statusText}`;
    } catch { return `${response.status} ${response.statusText}`; }
  }
}

module.exports = DeepSeekProvider;
