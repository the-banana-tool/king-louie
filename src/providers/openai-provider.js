const BaseLLMProvider = require('./base-provider');
const ImageHandler = require('../media/image-handler');
const { acceptsTemperature } = require('../models/capabilities');
const { createLogger } = require('../logging');
const log = createLogger('openai');

// Models that use the /v1/completions endpoint instead of /v1/chat/completions
const COMPLETIONS_MODELS = ['davinci', 'babbage', 'curie', 'ada'];

// Name-based guess for models the catalog does not know: these take no
// temperature (only the default of 1). GPT-5 and later are matched by number
// below, so a new generation (gpt-6-sol) is covered before the catalog is.
const NO_TEMPERATURE_MODELS = ['codex', 'o1', 'o3', 'o4', 'chatgpt-'];
const REASONING_GPT = /(?:^|[^a-z0-9])gpt-(\d+)/;

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

// Chat Completions refusals that mean "send this to /v1/responses instead".
// Reasoning models such as gpt-5.6-sol accept function tools only there.
function needsResponsesApi(message) {
  const err = String(message || '');
  return err.includes('not a chat model')
    || err.includes('only supported in v1/responses')
    || err.includes('use /v1/responses');
}

function guessSupportsTemperature(model) {
  const lower = String(model || '').toLowerCase();
  const gpt = lower.match(REASONING_GPT);
  if (gpt && Number(gpt[1]) >= 5) return false;
  return !NO_TEMPERATURE_MODELS.some((m) => lower.includes(m));
}

// OpenAI's 400 for a model that takes no temperature, e.g. "Unsupported
// parameter: 'temperature' is not supported with this model." or
// "Unsupported value: 'temperature' does not support 0.7 with this model."
function rejectsTemperature(message) {
  const err = String(message || '');
  return /unsupported (parameter|value)/i.test(err) && err.includes("'temperature'");
}

// Chat Completions content parts, as the Responses API names them.
function toResponsesPart(part) {
  if (part?.type === 'text') return { type: 'input_text', text: part.text };
  if (part?.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url };
  if (part?.type === 'file') return { type: 'input_file', filename: part.file?.filename, file_data: part.file?.file_data };
  return part;
}

// Models that rejected temperature at runtime, so later calls omit it
// without a failed round trip first. This beats the catalog, which can lag.
const _noTempModels = new Set();

function jsonBody(init) {
  if (typeof init?.body !== 'string') return null;
  try {
    return JSON.parse(init.body);
  } catch {
    return null;
  }
}

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
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://api.openai.com/v1');
  }

  prependSystemPrompt(messages = [], systemPrompt = '') {
    if (!systemPrompt || typeof systemPrompt !== 'string') {
      return messages;
    }

    return [{ role: 'system', content: systemPrompt }, ...(messages || [])];
  }

  getProviderName() {
    return 'openai';
  }

  // Whether to send `temperature`: a runtime refusal first, then the
  // catalog's flag, then the name-based guess for models it does not know.
  supportsTemperature(model) {
    const id = String(model || '').toLowerCase();
    if (_noTempModels.has(id)) return false;
    const known = acceptsTemperature(this.getCatalog(), this.getProviderName(), model);
    return known ?? guessSupportsTemperature(model);
  }

  temperatureParam(model, options = {}) {
    return this.supportsTemperature(model) ? { temperature: options.temperature ?? 0.7 } : {};
  }

  // A model that refuses `temperature` gets the same request again without
  // it, once, and is remembered so later calls leave it out. Covers every
  // endpoint (chat, completions, responses; streaming or not).
  async request(url, init = {}, options = {}) {
    const response = await super.request(url, init, options);
    if (response.ok || response.status !== 400 || typeof response.clone !== 'function') return response;
    const body = jsonBody(init);
    if (!body || !('temperature' in body)) return response;
    const text = await response.clone().text().catch(() => '');
    if (!rejectsTemperature(text)) return response;
    _noTempModels.add(String(body.model || '').toLowerCase());
    log.info(`Model ${body.model} does not take temperature; retrying without it.`);
    const { temperature: _dropped, ...rest } = body;
    return super.request(url, { ...init, body: JSON.stringify(rest) }, options);
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

    const buildDocParts = (documents = []) => {
      if (!Array.isArray(documents) || documents.length === 0) return [];
      return ImageHandler.normalizeMessageDocuments(documents).map((doc) =>
        ImageHandler.formatDocumentForProvider('openai', doc)
      );
    };

    const buildMultimodalContent = (text, images = [], documents = []) => {
      const imageParts = buildImageParts(images);
      const docParts = buildDocParts(documents);
      if (imageParts.length === 0 && docParts.length === 0) {
        return typeof text === 'string' ? text : '';
      }

      const content = [];
      if (typeof text === 'string' && text.trim()) {
        content.push({ type: 'text', text });
      }
      content.push(...docParts);
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
              : buildMultimodalContent(textContent, msg.images, msg.documents)
          };
        }

        if (msg.sender && typeof msg.text === 'string') {
          return {
            role: msg.sender === 'assistant' ? 'assistant' : 'user',
            content: buildMultimodalContent(msg.text, msg.images, msg.documents)
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  async sendMessage(messages, options = {}) {
    const model = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, this.systemText(options));

    if (isCompletionsModel(model)) {
      return this._sendCompletions(model, messagesToPrompt(this.formatMessages(preparedMessages)), options);
    }

    if (isResponsesModel(model)) {
      return this._sendResponses(model, preparedMessages, options);
    }

    const response = await this.request(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        messages: this.formatMessages(preparedMessages),
        ...this.temperatureParam(model, options),
        stream: false
      })
    }, options);

    if (!response.ok) {
      const providerError = await this.buildError(response);
      const err = providerError.message;
      if (needsResponsesApi(err)) {
        markAsResponsesModel(model);
        return this._sendResponses(model, preparedMessages, options);
      }
      throw providerError;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async _sendCompletions(model, prompt, options = {}) {
    const response = await this.request(`${this.baseUrl}/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        prompt,
        max_tokens: options.max_tokens || 4096,
        ...this.temperatureParam(model, options),
        stream: false
      })
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
    }

    const data = await response.json();
    return data.choices?.[0]?.text || '';
  }

  async sendMessageWithTools(messages, tools = [], options = {}) {
    const requestedModel = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, this.systemText(options));

    if (isCompletionsModel(requestedModel)) {
      return this._sendCompletionsWithTools(requestedModel, preparedMessages, tools, options);
    }

    if (isResponsesModel(requestedModel)) {
      return this._sendResponsesWithTools(requestedModel, preparedMessages, tools, options);
    }

    const response = await this.request(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        messages: this.formatMessages(preparedMessages),
        // Chat Completions rejects an empty tools list and tool_choice
        // without tools; a tool-less call (document ingest) omits both.
        ...(tools.length ? {
          tools: tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters
            }
          })),
          tool_choice: 'auto'
        } : {}),
        ...this.temperatureParam(requestedModel, options),
        stream: false
      })
    }, options);

    if (!response.ok) {
      const providerError = await this.buildError(response);
      const err = providerError.message;
      if (needsResponsesApi(err)) {
        markAsResponsesModel(requestedModel);
        return this._sendResponsesWithTools(requestedModel, preparedMessages, tools, options);
      }
      throw providerError;
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
    const response = await this.request(`${this.baseUrl}/completions`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        prompt,
        max_tokens: options.max_tokens || 4096,
        ...this.temperatureParam(model, options),
        stream: false
      })
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
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
    } catch (err) { log.debug(`tool call parse failed: ${err.message}`); }

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

      // Regular message: system→developer, content parts in Responses types
      const role = msg.role === 'system' ? 'developer' : msg.role;
      input.push({ role, content: Array.isArray(msg.content) ? msg.content.map(toResponsesPart) : msg.content });
    }

    return input;
  }

  async _sendResponses(model, messages, options = {}) {
    const input = this._formatResponsesInput(messages);

    const response = await this.request(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        input,
        ...this.temperatureParam(model, options)
      })
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
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

    const response = await this.request(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model,
        input,
        ...(responsesTools.length ? { tools: responsesTools } : {}),
        ...this.temperatureParam(model, options)
      })
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
    }

    const data = await response.json();
    const llmMetrics = this.buildLlmCallMetrics({
      model: data.model || model,
      usage: data.usage
    });

    // Check for function_call output items
    const fnCalls = (data.output || []).filter((item) => item.type === 'function_call');
    if (fnCalls.length > 0) {
      const toolCalls = fnCalls.map((fnCall) => {
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(fnCall.arguments || '{}'); } catch { parsedArgs = {}; }
        return {
          toolName: fnCall.name,
          toolUseId: fnCall.call_id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          parameters: parsedArgs
        };
      });

      return {
        type: 'tool_use',
        toolName: toolCalls[0].toolName,
        toolUseId: toolCalls[0].toolUseId,
        parameters: toolCalls[0].parameters,
        toolCalls,
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

    const functionCalls = (message.tool_calls || []).filter((call) => call.type === 'function' && call.function?.name);
    if (functionCalls.length > 0) {
      const toolCalls = functionCalls.map((call) => {
        let parsedArgs = {};
        try { parsedArgs = JSON.parse(call.function.arguments || '{}'); } catch { parsedArgs = {}; }
        return {
          toolName: call.function.name,
          toolUseId: call.id,
          parameters: parsedArgs
        };
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

  buildMultiToolMessages(response, toolCallEntries) {
    const messages = [
      {
        role: 'assistant',
        content: response.messageContent || '',
        tool_calls: toolCallEntries.map((entry) => ({
          id: entry.toolCallId,
          type: 'function',
          function: {
            name: entry.toolName,
            arguments: JSON.stringify(entry.parameters || {})
          }
        }))
      }
    ];

    for (const entry of toolCallEntries) {
      messages.push({
        role: 'tool',
        tool_call_id: entry.toolCallId,
        content: JSON.stringify(entry.result)
      });
    }

    return messages;
  }

  async streamMessage(messages, options = {}, onChunk) {
    const requestedModel = options.model || this.getDefaultModel();
    const preparedMessages = this.prependSystemPrompt(messages, this.systemText(options));

    if (isResponsesModel(requestedModel)) {
      return this._streamResponses(requestedModel, preparedMessages, options, onChunk);
    }

    const isCompletions = isCompletionsModel(requestedModel);
    const url = isCompletions
      ? `${this.baseUrl}/completions`
      : `${this.baseUrl}/chat/completions`;

    const body = isCompletions
      ? {
          model: requestedModel,
          prompt: messagesToPrompt(this.formatMessages(preparedMessages)),
          max_tokens: options.max_tokens || 4096,
          ...this.temperatureParam(requestedModel, options),
          stream: true,
          stream_options: { include_usage: true }
        }
      : {
          model: requestedModel,
          messages: this.formatMessages(preparedMessages),
          ...this.temperatureParam(requestedModel, options),
          stream: true,
          stream_options: { include_usage: true }
        };

    const response = await this.request(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    }, options);

    if (!response.ok) {
      const providerError = await this.buildError(response);
      const err = providerError.message;
      if (needsResponsesApi(err)) {
        markAsResponsesModel(requestedModel);
        return this._streamResponses(requestedModel, preparedMessages, options, onChunk);
      }
      throw providerError;
    }

    let usage = null;
    let model = requestedModel;

    const buildResult = () => ({
      llmMetrics: this.buildLlmCallMetrics({ model, usage })
    });

    return this.guardStream(options, () => ({ model, usage }), async () => {
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
    });
  }

  async _streamResponses(requestedModel, messages, options, onChunk) {
    const input = this._formatResponsesInput(messages);

    const response = await this.request(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        input,
        ...this.temperatureParam(requestedModel, options),
        stream: true
      })
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
    }

    let usage = null;
    let model = requestedModel;

    const buildResult = () => ({
      llmMetrics: this.buildLlmCallMetrics({ model, usage })
    });

    return this.guardStream(options, () => ({ model, usage }), async () => {
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
    });
  }

  /**
   * Embeddings (POST /embeddings): one vector per input, in input order.
   * Returns { vectors: number[][], usage: { input }, model }. A non-2xx
   * reply throws the provider error (its status tells a caller whether to
   * retry). The caller batches and truncates; this sends what it is given.
   */
  async embed(inputs, { model, dimensions, abortSignal } = {}) {
    if (!Array.isArray(inputs) || !inputs.length) throw new Error('embed needs at least one input');
    if (!model) throw new Error('embed needs a model');
    const body = { model, input: inputs.map(String), encoding_format: 'float' };
    if (Number.isInteger(dimensions) && dimensions > 0) body.dimensions = dimensions;
    const response = await this.request(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    }, { abortSignal, model });
    if (!response.ok) throw await this.buildError(response, { model });
    const data = await response.json();
    const rows = Array.isArray(data?.data) ? [...data.data].sort((a, b) => a.index - b.index) : [];
    if (rows.length !== inputs.length || rows.some((r) => !Array.isArray(r.embedding))) {
      throw new Error(`embeddings reply has ${rows.length} vectors for ${inputs.length} inputs`);
    }
    const input = Number(data?.usage?.prompt_tokens ?? data?.usage?.total_tokens);
    return { vectors: rows.map((r) => r.embedding), usage: { input: Number.isFinite(input) ? input : null }, model: data?.model || model };
  }

  async listModels(options = {}) {
    const response = await this.request(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: this.getHeaders()
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
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
module.exports.needsResponsesApi = needsResponsesApi;
module.exports.rejectsTemperature = rejectsTemperature;
module.exports.guessSupportsTemperature = guessSupportsTemperature;