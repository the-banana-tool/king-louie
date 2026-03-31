const BaseLLMProvider = require('./base-provider');
const ImageHandler = require('../media/image-handler');

// Models that use the /v1/completions endpoint instead of /v1/chat/completions
const COMPLETIONS_MODELS = ['davinci', 'babbage', 'curie', 'ada'];

// Models that don't support temperature (only default of 1)
const NO_TEMPERATURE_MODELS = ['codex', 'o1', 'o3', 'o4', 'gpt-5', 'chatgpt-'];

// Runtime cache: models that need /v1/responses instead of /v1/chat/completions
const _responsesModels = new Set();

function isCompletionsModel(model) {
  const lower = String(model || '').toLowerCase();
  return COMPLETIONS_MODELS.some((m) => lower.includes(m));
}

function isResponsesModel(model) {
  return _responsesModels.has(String(model || '').toLowerCase());
}

function markAsResponsesModel(model) {
  _responsesModels.add(String(model || '').toLowerCase());
}

function supportsTemperature(model) {
  const lower = String(model || '').toLowerCase();
  return !NO_TEMPERATURE_MODELS.some((m) => lower.includes(m));
}

function temperatureParam(model, options = {}) {
  return supportsTemperature(model) ? { temperature: options.temperature ?? 0.7 } : {};
}

// Track models that rejected temperature at runtime so we don't retry every call
const _noTempModels = new Set();

/**
 * Convert chat messages array into a single prompt string for the completions endpoint.
 */
function messagesToPrompt(messages) {
  return (messages || []).map((msg) => {
    const role = msg.role || msg.sender || 'user';
    const text = msg.content || msg.text || '';
    const content = typeof text === 'string' ? text : JSON.stringify(text);
    return `${role}: ${content}`;
  }).join('\n\n') + '\n\nassistant:';
}

/**
 * Build a completions prompt that includes tool definitions so the model
 * can respond with structured tool calls using a simple JSON format.
 */
function messagesToPromptWithTools(messages, tools) {
  const toolDefs = (tools || []).map((t) =>
    `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters || {})}`
  ).join('\n');

  const toolSection = tools?.length
    ? `\nYou have these tools available. To use a tool, respond with ONLY a JSON block like {"tool": "ToolName", "parameters": {...}}. Otherwise respond with plain text.\n\nTools:\n${toolDefs}\n`
    : '';

  return messagesToPrompt([
    { role: 'system', content: toolSection },
    ...messages
  ]);
}

class OpenAIProvider extends BaseLLMProvider {
  prependSystemPrompt(messages = [], systemPrompt = '') {
    if (!systemPrompt || typeof systemPrompt !== 'string') {
      return messages;
    }

    return [{ role: 'system', content: systemPrompt }, ...(messages || [])];
  }

  getProviderName() {
    return 'openai';
  }

  getModels() {
    return [
      'gpt-5.4-pro',
      'gpt-5',
      'gpt-5-mini',
      'gpt-5.4-mini',
      'gpt-5.2-codex',
      'gpt-4.1',
      'gpt-4.1-mini',
      'gpt-4o',
      'gpt-4o-mini',
      'o4-mini',
      'o3-mini',
      'o1',
      'o1-mini',
      'gpt-4-turbo',
      'gpt-4'
    ];
  }

  getModelPricingTable() {
    return {
      'gpt-5.4-pro': { inputPerMillion: 3, outputPerMillion: 15 },
      'gpt-5': { inputPerMillion: 3, outputPerMillion: 15 },
      'gpt-5-mini': { inputPerMillion: 0.5, outputPerMillion: 2 },
      'gpt-5.2-codex': { inputPerMillion: 3, outputPerMillion: 15 },
      'gpt-4.1': { inputPerMillion: 2, outputPerMillion: 8 },
      'gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6 },
      'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
      'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
      'o4-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 },
      'o3-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 },
      'o1': { inputPerMillion: 15, outputPerMillion: 60 },
      'o1-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 }
    };
  }

  getDefaultModel() {
    return 'gpt-4o-mini';
  }

  getHeaders() {
    return {
      ...super.getHeaders()
    };
  }

  formatMessages(chatHistory) {
    const buildImageParts = (images = []) => {
      if (!Array.isArray(images) || images.length === 0) {
        return [];
      }

      return ImageHandler.normalizeMessageImages(images).map((image) =>
        ImageHandler.formatForProvider('openai', image)
      );
    };

    const buildMultimodalContent = (text, images = []) => {
      const imageParts = buildImageParts(images);
      if (imageParts.length === 0) {
        return typeof text === 'string' ? text : '';
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

        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
          return {
            role: 'assistant',
            content: msg.content || '',
            tool_calls: msg.tool_calls
          };
        }

        if (msg.role === 'tool') {
          return {
            role: 'tool',
            tool_call_id: msg.tool_call_id,
            content: msg.content || ''
          };
        }

        if (msg.role && (typeof msg.content === 'string' || Array.isArray(msg.content))) {
          const textContent = typeof msg.content === 'string' ? msg.content : '';
          return {
            role: msg.role,
            content: Array.isArray(msg.content)
              ? msg.content
              : buildMultimodalContent(textContent, msg.images)
          };
        }

        if (msg.sender && typeof msg.text === 'string') {
          return {
            role: msg.sender === 'assistant' ? 'assistant' : 'user',
            content: buildMultimodalContent(msg.text, msg.images)
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  async sendMessage(messages, options = {}) {
    const model = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, options.systemPrompt);

    if (isCompletionsModel(model)) {
      return this._sendCompletions(model, messagesToPrompt(this.formatMessages(preparedMessages)), options);
    }

    if (isResponsesModel(model)) {
      return this._sendResponses(model, preparedMessages, options);
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        messages: this.formatMessages(preparedMessages),
        ...temperatureParam(model, options),
        stream: false
      })
    });

    if (!response.ok) {
      const err = await this.extractError(response);
      if (err.includes('not a chat model')) {
        markAsResponsesModel(model);
        return this._sendResponses(model, preparedMessages, options);
      }
      throw new Error(err);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async _sendCompletions(model, prompt, options = {}) {
    const response = await fetch('https://api.openai.com/v1/completions', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        prompt,
        max_tokens: options.max_tokens || 4096,
        ...temperatureParam(model, options),
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const data = await response.json();
    return data.choices?.[0]?.text || '';
  }

  async sendMessageWithTools(messages, tools = [], options = {}) {
    const requestedModel = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, options.systemPrompt);

    if (isCompletionsModel(requestedModel)) {
      return this._sendCompletionsWithTools(requestedModel, preparedMessages, tools, options);
    }

    if (isResponsesModel(requestedModel)) {
      return this._sendResponsesWithTools(requestedModel, preparedMessages, tools, options);
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        messages: this.formatMessages(preparedMessages),
        tools: tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }
        })),
        tool_choice: 'auto',
        ...temperatureParam(requestedModel, options),
        stream: false
      })
    });

    if (!response.ok) {
      const err = await this.extractError(response);
      if (err.includes('not a chat model')) {
        markAsResponsesModel(requestedModel);
        return this._sendResponsesWithTools(requestedModel, preparedMessages, tools, options);
      }
      throw new Error(err);
    }

    const data = await response.json();
    const llmMetrics = this.buildLlmCallMetrics({
      model: data.model || requestedModel,
      usage: data.usage
    });

    return this.parseToolResponse(data, llmMetrics);
  }

  async _sendCompletionsWithTools(model, messages, tools, options = {}) {
    const prompt = messagesToPromptWithTools(this.formatMessages(messages), tools);
    const response = await fetch('https://api.openai.com/v1/completions', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        prompt,
        max_tokens: options.max_tokens || 4096,
        ...temperatureParam(model, options),
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const data = await response.json();
    const text = (data.choices?.[0]?.text || '').trim();
    const llmMetrics = this.buildLlmCallMetrics({
      model: data.model || model,
      usage: data.usage
    });

    // Try to parse a tool call from the response
    try {
      const parsed = JSON.parse(text);
      if (parsed?.tool && typeof parsed.tool === 'string') {
        return {
          type: 'tool_use',
          toolName: parsed.tool,
          toolUseId: `call_${Date.now()}`,
          parameters: parsed.parameters || {},
          messageContent: '',
          llmMetrics
        };
      }
    } catch (err) { console.debug('[openai] tool call parse failed:', err.message); }

    return { type: 'text', content: text, llmMetrics };
  }

  /**
   * Convert chat messages to the Responses API input format.
   * Maps system→developer, and converts chat-format tool_calls/tool messages
   * into the Responses API function_call / function_call_output items.
   */
  _formatResponsesInput(messages) {
    const formatted = this.formatMessages(messages);
    const input = [];

    for (const msg of formatted) {
      // Assistant message with tool_calls → function_call items
      if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
        if (msg.content) {
          input.push({ role: 'assistant', content: msg.content });
        }
        for (const tc of msg.tool_calls) {
          input.push({
            type: 'function_call',
            name: tc.function?.name,
            call_id: tc.id,
            arguments: tc.function?.arguments || '{}'
          });
        }
        continue;
      }

      // Tool result → function_call_output
      if (msg.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: msg.tool_call_id,
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        });
        continue;
      }

      // Regular message: system→developer, everything else passes through
      const role = msg.role === 'system' ? 'developer' : msg.role;
      input.push({ role, content: msg.content });
    }

    return input;
  }

  async _sendResponses(model, messages, options = {}) {
    const input = this._formatResponsesInput(messages);

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        input,
        ...temperatureParam(model, options)
      })
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const data = await response.json();
    // Extract text from output items
    const textItem = data.output?.find((item) => item.type === 'message');
    const text = textItem?.content
      ?.filter((c) => c.type === 'output_text')
      .map((c) => c.text)
      .join('') || '';
    return text;
  }

  async _sendResponsesWithTools(model, messages, tools, options = {}) {
    const input = this._formatResponsesInput(messages);

    const responsesTools = (tools || []).map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        input,
        tools: responsesTools,
        ...temperatureParam(model, options)
      })
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const data = await response.json();
    const llmMetrics = this.buildLlmCallMetrics({
      model: data.model || model,
      usage: data.usage
    });

    // Check for function_call output items
    const fnCall = data.output?.find((item) => item.type === 'function_call');
    if (fnCall) {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(fnCall.arguments || '{}');
      } catch {
        parsedArgs = {};
      }
      return {
        type: 'tool_use',
        toolName: fnCall.name,
        toolUseId: fnCall.call_id || `call_${Date.now()}`,
        parameters: parsedArgs,
        messageContent: '',
        llmMetrics
      };
    }

    // Fall back to text
    const textItem = data.output?.find((item) => item.type === 'message');
    const text = textItem?.content
      ?.filter((c) => c.type === 'output_text')
      .map((c) => c.text)
      .join('') || '';
    return { type: 'text', content: text, llmMetrics };
  }

  parseToolResponse(response, llmMetrics) {
    const message = response?.choices?.[0]?.message;
    if (!message) {
      return {
        type: 'text',
        content: '',
        llmMetrics
      };
    }

    const toolCall = message.tool_calls?.find((call) => call.type === 'function');
    if (toolCall?.function?.name) {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        parsedArgs = {};
      }

      return {
        type: 'tool_use',
        toolName: toolCall.function.name,
        toolUseId: toolCall.id,
        parameters: parsedArgs,
        messageContent: message.content || '',
        llmMetrics
      };
    }

    return {
      type: 'text',
      content: message.content || '',
      llmMetrics
    };
  }

  buildToolMessages(response, toolResult, toolCallId) {
    return [
      {
        role: 'assistant',
        content: response.messageContent || '',
        tool_calls: [
          {
            id: toolCallId,
            type: 'function',
            function: {
              name: response.toolName,
              arguments: JSON.stringify(response.parameters || {})
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: toolCallId,
        content: JSON.stringify(toolResult)
      }
    ];
  }

  async streamMessage(messages, options = {}, onChunk) {
    const requestedModel = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, options.systemPrompt);

    if (isResponsesModel(requestedModel)) {
      return this._streamResponses(requestedModel, preparedMessages, options, onChunk);
    }

    const isCompletions = isCompletionsModel(requestedModel);
    const url = isCompletions
      ? 'https://api.openai.com/v1/completions'
      : 'https://api.openai.com/v1/chat/completions';

    const body = isCompletions
      ? {
          model: requestedModel,
          prompt: messagesToPrompt(this.formatMessages(preparedMessages)),
          max_tokens: options.max_tokens || 4096,
          ...temperatureParam(requestedModel, options),
          stream: true,
          stream_options: { include_usage: true }
        }
      : {
          model: requestedModel,
          messages: this.formatMessages(preparedMessages),
          ...temperatureParam(requestedModel, options),
          stream: true,
          stream_options: { include_usage: true }
        };

    const response = await fetch(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await this.extractError(response);
      if (err.includes('not a chat model')) {
        markAsResponsesModel(requestedModel);
        return this._streamResponses(requestedModel, preparedMessages, options, onChunk);
      }
      throw new Error(err);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    let model = requestedModel;

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
        if (data === '[DONE]') return buildResult();

        try {
          const parsed = JSON.parse(data);
          if (parsed?.usage) {
            usage = parsed.usage;
          }

          if (parsed?.model) {
            model = parsed.model;
          }

          // Chat completions use delta.content; completions use text
          const content = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.text;
          if (content) onChunk(content);
        } catch {
          // Ignore malformed partial chunks
        }
      }
    }

    return buildResult();
  }

  async _streamResponses(requestedModel, messages, options, onChunk) {
    const input = this._formatResponsesInput(messages);

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        input,
        ...temperatureParam(requestedModel, options),
        stream: true
      })
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;
    let model = requestedModel;

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
        if (!trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (!data) continue;

        try {
          const parsed = JSON.parse(data);
          const eventType = parsed?.type;

          // Text content delta
          if (eventType === 'response.output_text.delta' && parsed.delta) {
            onChunk(parsed.delta);
          }

          // Usage from the completed event
          if (eventType === 'response.completed' && parsed.response) {
            if (parsed.response.usage) {
              usage = parsed.response.usage;
            }
            if (parsed.response.model) {
              model = parsed.response.model;
            }
            return buildResult();
          }

          // Capture model from early events
          if (eventType === 'response.created' && parsed.response?.model) {
            model = parsed.response.model;
          }
        } catch {
          // Ignore malformed partial chunks
        }
      }
    }

    return buildResult();
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