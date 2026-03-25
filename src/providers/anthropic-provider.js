const BaseLLMProvider = require('./base-provider');
const ImageHandler = require('../media/image-handler');

class AnthropicProvider extends BaseLLMProvider {
  getProviderName() {
    return 'anthropic';
  }

  getModels() {
    return [
      'claude-sonnet-4-20250514',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
      'claude-3-opus-latest'
    ];
  }

  getModelPricingTable() {
    return {
      'claude-sonnet-4': { inputPerMillion: 3, outputPerMillion: 15 },
      'claude-opus-4': { inputPerMillion: 15, outputPerMillion: 75 },
      'claude-haiku-4': { inputPerMillion: 0.8, outputPerMillion: 4 },
      'claude-3-7-sonnet': { inputPerMillion: 3, outputPerMillion: 15 },
      'claude-3-5-sonnet': { inputPerMillion: 3, outputPerMillion: 15 },
      'claude-3-5-haiku': { inputPerMillion: 0.8, outputPerMillion: 4 },
      'claude-3-opus': { inputPerMillion: 15, outputPerMillion: 75 }
    };
  }

  getDefaultModel() {
    return 'claude-sonnet-4-20250514';
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01'
    };
  }

  formatMessages(chatHistory) {
    const buildContent = (text, images = []) => {
      const imageParts = Array.isArray(images) && images.length > 0
        ? ImageHandler.normalizeMessageImages(images).map((image) =>
            ImageHandler.formatForProvider('anthropic', image)
          )
        : [];

      if (imageParts.length === 0) {
        return text;
      }

      const content = [];
      if (typeof text === 'string' && text.trim()) {
        content.push({ type: 'text', text });
      }
      content.push(...imageParts);
      return content;
    };

    return (chatHistory || [])
      .map((msg) => {
        if (!msg) return null;

        if (msg.role === 'assistant' || msg.role === 'user') {
          if (Array.isArray(msg.content)) {
            return {
              role: msg.role,
              content: msg.content
            };
          }

          return {
            role: msg.role,
            content: buildContent(msg.content, msg.images)
          };
        }

        if (msg.sender && typeof msg.text === 'string') {
          return {
            role: msg.sender === 'assistant' ? 'assistant' : 'user',
            content: buildContent(msg.text, msg.images)
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  async sendMessage(messages, options = {}) {
    const systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || this.getDefaultModel(),
        messages: this.formatMessages(messages),
        ...(systemPrompt ? { system: systemPrompt } : {}),
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

  async sendMessageWithTools(messages, tools = [], options = {}) {
    const requestedModel = options.model || this.getDefaultModel();
    const systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        messages: this.formatMessages(messages),
        ...(systemPrompt ? { system: systemPrompt } : {}),
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters
        })),
        max_tokens: options.max_tokens || 4096,
        temperature: options.temperature ?? 0.7,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const data = await response.json();
    const llmMetrics = this.buildLlmCallMetrics({
      model: data.model || requestedModel,
      usage: data.usage
    });
    return this.parseToolResponse(data, llmMetrics);
  }

  parseToolResponse(response, llmMetrics) {
    const content = Array.isArray(response?.content) ? response.content : [];
    const toolUse = content.find((block) => block.type === 'tool_use');
    const textBlocks = content.filter((block) => block.type === 'text');

    if (toolUse) {
      return {
        type: 'tool_use',
        toolName: toolUse.name,
        toolUseId: toolUse.id,
        parameters: toolUse.input || {},
        messageContent: textBlocks.map((block) => block.text).join('\n'),
        llmMetrics
      };
    }

    return {
      type: 'text',
      content: textBlocks.map((block) => block.text).join('\n'),
      llmMetrics
    };
  }

  buildToolMessages(response, toolResult, toolCallId) {
    const assistantContent = [];

    if (response.messageContent) {
      assistantContent.push({ type: 'text', text: response.messageContent });
    }

    assistantContent.push({
      type: 'tool_use',
      id: toolCallId,
      name: response.toolName,
      input: response.parameters || {}
    });

    return [
      {
        role: 'assistant',
        content: assistantContent
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: JSON.stringify(toolResult)
          }
        ]
      }
    ];
  }

  async streamMessage(messages, options = {}, onChunk) {
    const requestedModel = options.model || this.getDefaultModel();
    const systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        messages: this.formatMessages(messages),
        ...(systemPrompt ? { system: systemPrompt } : {}),
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
    let model = requestedModel;
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0
    };

    const buildResult = () => ({
      llmMetrics: this.buildLlmCallMetrics({ model, usage })
    });

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

          if (parsed?.type === 'message_start') {
            model = parsed?.message?.model || model;
            usage.input_tokens = Number(parsed?.message?.usage?.input_tokens ?? usage.input_tokens) || 0;
            usage.output_tokens = Number(parsed?.message?.usage?.output_tokens ?? usage.output_tokens) || 0;
          }

          if (parsed?.type === 'message_delta') {
            const nextOutput = Number(parsed?.usage?.output_tokens);
            if (!Number.isNaN(nextOutput)) {
              usage.output_tokens = nextOutput;
            }
          }

          if (parsed?.type === 'message_stop') {
            usage.total_tokens = usage.input_tokens + usage.output_tokens;
            return buildResult();
          }

          const content = parsed?.delta?.text || parsed?.content_block?.text;
          if (content) onChunk(content);
        } catch {
          // Ignore malformed partial chunks
        }
      }
    }

    usage.total_tokens = usage.input_tokens + usage.output_tokens;
    return buildResult();
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