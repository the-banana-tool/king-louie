const BaseLLMProvider = require('./base-provider');

/**
 * GitHub Copilot provider.
 *
 * Copilot's chat endpoint is OpenAI-compatible, but auth is two-stage: the
 * stored credential is a GitHub OAuth/PAT token, which must be exchanged for a
 * short-lived Copilot session token before each call. We cache that session
 * token until it nears expiry.
 */
class CopilotProvider extends BaseLLMProvider {
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.githubToken = apiKey;
    this.baseUrl = 'https://api.githubcopilot.com';
    this.tokenExchangeUrl = 'https://api.github.com/copilot_internal/v2/token';
    this._copilotToken = null;
    this._copilotTokenExpiresAt = 0;
  }

  getName() { return 'copilot'; }
  getLabel() { return 'GitHub Copilot'; }
  getProviderName() { return 'copilot'; }

  getModels() {
    return [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000 },
      { id: 'o1', name: 'o1', contextWindow: 200000 },
      { id: 'o3-mini', name: 'o3-mini', contextWindow: 200000 },
      { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', contextWindow: 200000 }
    ];
  }

  getDefaultModel() {
    return 'gpt-4o';
  }

  /**
   * Exchange the GitHub token for a short-lived Copilot session token.
   * Cached until ~1 minute before expiry.
   */
  async getCopilotToken() {
    if (this._copilotToken && Date.now() < this._copilotTokenExpiresAt - 60_000) {
      return this._copilotToken;
    }

    const response = await fetch(this.tokenExchangeUrl, {
      headers: {
        Authorization: `token ${this.githubToken}`,
        Accept: 'application/json',
        'User-Agent': 'king-louie-app'
      }
    });

    if (!response.ok) {
      throw await this.buildError(response);
    }

    const data = await response.json();
    if (!data.token) {
      throw new Error('Copilot token exchange returned no token (is Copilot enabled for this account?)');
    }

    this._copilotToken = data.token;
    // expires_at is unix seconds; fall back to a conservative 25 minutes.
    this._copilotTokenExpiresAt = data.expires_at
      ? data.expires_at * 1000
      : Date.now() + 25 * 60 * 1000;
    return this._copilotToken;
  }

  async getRequestHeaders() {
    const token = await this.getCopilotToken();
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Editor-Version': 'KingLouie/1.0',
      'Editor-Plugin-Version': 'king-louie/1.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'User-Agent': 'GitHubCopilotChat/1.0'
    };
  }

  prependSystemPrompt(messages = [], systemPrompt = '') {
    if (!systemPrompt || typeof systemPrompt !== 'string') {
      return messages;
    }
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
      headers: await this.getRequestHeaders(),
      body: JSON.stringify({
        model: options.model || this.getDefaultModel(),
        messages: this.formatMessages(preparedMessages),
        temperature: options.temperature ?? 0.7,
        stream: false
      })
    });

    if (!response.ok) {
      throw await this.buildError(response);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async sendMessageWithTools(messages, tools = [], options = {}) {
    const requestedModel = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, options.systemPrompt);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: await this.getRequestHeaders(),
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

    if (!response.ok) {
      throw await this.buildError(response);
    }

    const data = await response.json();
    const llmMetrics = this.buildLlmCallMetrics({ model: data.model || requestedModel, usage: data.usage });
    return this.parseToolResponse(data, llmMetrics);
  }

  parseToolResponse(response, llmMetrics) {
    const message = response?.choices?.[0]?.message;
    if (!message) {
      return { type: 'text', content: '', llmMetrics };
    }

    const functionCalls = (message.tool_calls || []).filter((call) => call.type === 'function' && call.function?.name);
    if (functionCalls.length > 0) {
      const toolCalls = functionCalls.map((call) => {
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(call.function.arguments || '{}'); } catch { parsedArgs = {}; }
        return { toolName: call.function.name, toolUseId: call.id, parameters: parsedArgs };
      });

      return {
        type: 'tool_use',
        toolName: toolCalls[0].toolName,
        toolUseId: toolCalls[0].toolUseId,
        parameters: toolCalls[0].parameters,
        toolCalls,
        messageContent: message.content || '',
        llmMetrics
      };
    }

    return { type: 'text', content: message.content || '', llmMetrics };
  }

  buildToolMessages(response, toolResult, toolCallId) {
    return [
      {
        role: 'assistant',
        content: response.messageContent || '',
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: { name: response.toolName, arguments: JSON.stringify(response.parameters || {}) }
        }]
      },
      { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify(toolResult) }
    ];
  }

  buildMultiToolMessages(response, toolCallEntries) {
    const messages = [{
      role: 'assistant',
      content: response.messageContent || '',
      tool_calls: toolCallEntries.map((entry) => ({
        id: entry.toolCallId,
        type: 'function',
        function: { name: entry.toolName, arguments: JSON.stringify(entry.parameters || {}) }
      }))
    }];
    for (const entry of toolCallEntries) {
      messages.push({ role: 'tool', tool_call_id: entry.toolCallId, content: JSON.stringify(entry.result) });
    }
    return messages;
  }

  async streamMessage(messages, options = {}, onChunk) {
    const requestedModel = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, options.systemPrompt);
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: await this.getRequestHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        messages: this.formatMessages(preparedMessages),
        temperature: options.temperature ?? 0.7,
        stream: true
      })
    });

    if (!response.ok) {
      throw await this.buildError(response);
    }

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
        } catch {
          // Ignore malformed partial chunks
        }
      }
    }

    return buildResult();
  }

  async listModels() {
    const response = await fetch(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: await this.getRequestHeaders()
    });

    if (!response.ok) {
      throw await this.buildError(response);
    }

    const data = await response.json();
    return (data.data || []).map((model) => model.id).sort();
  }

  async extractError(response) {
    try {
      const body = await response.json();
      return body?.error?.message || body?.message || `${response.status} ${response.statusText}`;
    } catch {
      return `${response.status} ${response.statusText}`;
    }
  }
}

module.exports = CopilotProvider;
