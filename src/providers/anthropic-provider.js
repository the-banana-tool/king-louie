const BaseLLMProvider = require('./base-provider');
const ImageHandler = require('../media/image-handler');
const { acceptsTemperature } = require('../models/capabilities');
const { createLogger } = require('../logging');
const log = createLogger('anthropic');

// Anthropic's 400 for a model that takes no temperature, e.g. "`temperature`
// is deprecated for this model." (Claude 5) or "temperature: Extra inputs are
// not permitted".
function rejectsTemperature(message) {
  const err = String(message || '');
  return /temperature/i.test(err) && /deprecated|not supported|unsupported|not permitted/i.test(err);
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

// Models that support extended thinking (Claude 3.7+)
const THINKING_CAPABLE_MODELS = [
  'claude-sonnet-4', 'claude-opus-4',
  'claude-3-7-sonnet', 'claude-3-5-sonnet'
];

function modelSupportsThinking(model) {
  const normalized = String(model).toLowerCase();
  return THINKING_CAPABLE_MODELS.some(prefix => normalized.startsWith(prefix));
}

class AnthropicProvider extends BaseLLMProvider {
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://api.anthropic.com/v1');
  }

  // Whether to send `temperature`: a runtime refusal first, then the
  // catalog's flag; a model neither knows about gets it, as every Claude
  // before the 5 family took it.
  supportsTemperature(model) {
    if (_noTempModels.has(String(model || '').toLowerCase())) return false;
    return acceptsTemperature(this.getCatalog(), 'anthropic', model) ?? true;
  }

  // Extended thinking needs temperature 1 where temperature is taken at all.
  temperatureParam(model, options = {}, thinking = null) {
    if (!this.supportsTemperature(model)) return {};
    return { temperature: thinking ? 1 : (options.temperature ?? 0.7) };
  }

  // A model that refuses `temperature` gets the same request again without
  // it, once, and is remembered so later calls leave it out.
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

  getProviderName() {
    return 'anthropic';
  }

  getModels() {
    return [
      'claude-sonnet-5',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
      'claude-3-opus-latest'
    ];
  }

  getDefaultModel() {
    return 'claude-sonnet-5';
  }

  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    };

    if (this.authMode === 'oauth') {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    } else {
      headers['x-api-key'] = this.apiKey;
    }

    return headers;
  }

  /**
   * Build a structured system prompt with cache_control breakpoints.
   * Anthropic's prompt caching caches everything up to a cache_control
   * block, so we place the breakpoint on the last (most stable) section.
   * This gives a 5-minute TTL cache that avoids re-processing the system
   * prompt on every turn — saving 50-90% of input token costs.
   */
  /**
   * Mark the tools block as cacheable. Anthropic caches everything up to and
   * including the cache_control breakpoint, so attaching it to the last tool
   * caches the whole tools array (often the bulk of input tokens — the
   * Browser tool alone is ~5k tokens). Cache hits cost 10% of normal input
   * and process faster, which materially speeds up agent loops.
   *
   * Two breakpoints when ToolSearch is present: one right after ToolSearch
   * (preserves the core-tools cache when later tools are appended via
   * deferred loading) and one on the final tool (caches the full current
   * set). Anthropic allows up to 4 breakpoints; using 2 here is safe.
   */
  buildCachedTools(tools) {
    const formatted = (tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }));
    if (formatted.length === 0) return formatted;

    const breakpoints = new Set();
    const toolSearchIdx = formatted.findIndex((t) => t.name === 'ToolSearch');
    if (toolSearchIdx >= 0 && toolSearchIdx < formatted.length - 1) {
      breakpoints.add(toolSearchIdx);
    }
    breakpoints.add(formatted.length - 1);

    for (const idx of breakpoints) {
      formatted[idx] = { ...formatted[idx], cache_control: { type: 'ephemeral' } };
    }
    return formatted;
  }

  // The stable system prompt is cached; the per-turn dynamic part (case
  // orientation, recalled block, memory context) follows it uncached, so a
  // turn's changes no longer break the cache (recall spec §6.5).
  buildCachedSystemPrompt(systemPrompt, dynamic = '') {
    const blocks = Array.isArray(systemPrompt)
      ? [...systemPrompt]
      : (systemPrompt ? [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }] : []);
    if (typeof dynamic === 'string' && dynamic.trim()) blocks.push({ type: 'text', text: dynamic });
    return blocks.length ? blocks : undefined;
  }

  formatMessages(chatHistory) {
    const buildContent = (text, images = [], documents = []) => {
      const imageParts = Array.isArray(images) && images.length > 0
        ? ImageHandler.normalizeMessageImages(images).map((image) =>
            ImageHandler.formatForProvider('anthropic', image)
          )
        : [];

      const docParts = Array.isArray(documents) && documents.length > 0
        ? ImageHandler.normalizeMessageDocuments(documents).map((doc) =>
            ImageHandler.formatDocumentForProvider('anthropic', doc)
          )
        : [];

      if (imageParts.length === 0 && docParts.length === 0) {
        return text;
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

        if (msg.role === 'assistant' || msg.role === 'user') {
          if (Array.isArray(msg.content)) {
            return {
              role: msg.role,
              content: msg.content
            };
          }

          return {
            role: msg.role,
            content: buildContent(msg.content, msg.images, msg.documents)
          };
        }

        if (msg.sender && typeof msg.text === 'string') {
          return {
            role: msg.sender === 'assistant' ? 'assistant' : 'user',
            content: buildContent(msg.text, msg.images, msg.documents)
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  normalizeUsage(usage = {}) {
    const base = super.normalizeUsage(usage);
    return {
      ...base,
      cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0) || 0,
      cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0) || 0
    };
  }

  // Anthropic's input_tokens excludes cache reads and writes; they are
  // separate counts, each priced at its own catalog rate.
  usageForPricing(normalized) {
    return {
      input: normalized.inputTokens,
      cachedInput: normalized.cacheReadInputTokens,
      cacheWrite: normalized.cacheCreationInputTokens,
      output: normalized.outputTokens,
      reasoning: 0
    };
  }

  /**
   * Build the thinking parameter for models that support extended thinking.
   */
  buildThinkingParam(model, options) {
    if (options.thinking === false) return null;
    if (!modelSupportsThinking(model)) return null;

    // Explicit thinking config from options
    if (options.thinking && typeof options.thinking === 'object') {
      return options.thinking;
    }

    // Enable by default with a budget for capable models when explicitly opted in
    if (options.thinking === true || options.enableThinking === true) {
      return {
        type: 'enabled',
        budget_tokens: options.thinkingBudget || 10000
      };
    }

    return null;
  }

  async sendMessage(messages, options = {}) {
    const systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
    const cachedSystem = this.buildCachedSystemPrompt(systemPrompt, options.systemPromptDynamic);
    const response = await this.request(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || this.getDefaultModel(),
        messages: this.formatMessages(messages),
        ...(cachedSystem ? { system: cachedSystem } : {}),
        max_tokens: options.max_tokens || 4096,
        ...this.temperatureParam(options.model || this.getDefaultModel(), options),
        stream: false
      })
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
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
    const cachedSystem = this.buildCachedSystemPrompt(systemPrompt, options.systemPromptDynamic);
    const thinking = this.buildThinkingParam(requestedModel, options);

    const body = {
      model: requestedModel,
      messages: this.formatMessages(messages),
      ...(cachedSystem ? { system: cachedSystem } : {}),
      ...(tools && tools.length ? { tools: this.buildCachedTools(tools) } : {}),
      max_tokens: options.max_tokens || 4096,
      stream: false
    };

    if (thinking) body.thinking = thinking;
    Object.assign(body, this.temperatureParam(requestedModel, options, thinking));

    const response = await this.request(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
    }

    const data = await response.json();
    const llmMetrics = this.buildLlmCallMetrics({
      model: data.model || requestedModel,
      usage: data.usage
    });
    return this.parseToolResponse(data, llmMetrics);
  }

  /**
   * Streaming version of sendMessageWithTools.
   * Streams text deltas via onChunk callback while collecting tool_use blocks.
   * Returns the same response format as sendMessageWithTools.
   */
  async streamMessageWithTools(messages, tools = [], options = {}, onChunk) {
    const requestedModel = options.model || this.getDefaultModel();
    const systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
    const cachedSystem = this.buildCachedSystemPrompt(systemPrompt, options.systemPromptDynamic);
    const thinking = this.buildThinkingParam(requestedModel, options);

    const body = {
      model: requestedModel,
      messages: this.formatMessages(messages),
      ...(cachedSystem ? { system: cachedSystem } : {}),
      tools: this.buildCachedTools(tools),
      max_tokens: options.max_tokens || 4096,
      stream: true
    };

    if (thinking) body.thinking = thinking;
    Object.assign(body, this.temperatureParam(requestedModel, options, thinking));

    const response = await this.request(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
    }

    let model = requestedModel;
    const usage = {
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0
    };

    return this.guardStream(options, () => ({ model, usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens } }), async () => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Accumulate content blocks as they stream in
      const contentBlocks = []; // { type, index, ... }
      let currentBlockIndex = -1;
      let currentBlockType = null;
      let inputJsonBuffer = '';

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
              const msgUsage = parsed?.message?.usage;
              if (msgUsage) {
                usage.input_tokens = Number(msgUsage.input_tokens ?? 0) || 0;
                usage.output_tokens = Number(msgUsage.output_tokens ?? 0) || 0;
                usage.cache_creation_input_tokens = Number(msgUsage.cache_creation_input_tokens ?? 0) || 0;
                usage.cache_read_input_tokens = Number(msgUsage.cache_read_input_tokens ?? 0) || 0;
              }
            }

            if (parsed?.type === 'content_block_start') {
              currentBlockIndex = parsed.index;
              const block = parsed.content_block;
              currentBlockType = block?.type;
              if (block?.type === 'tool_use') {
                contentBlocks[currentBlockIndex] = { type: 'tool_use', id: block.id, name: block.name, input: '' };
                inputJsonBuffer = '';
              } else if (block?.type === 'text') {
                contentBlocks[currentBlockIndex] = { type: 'text', text: '' };
              } else if (block?.type === 'thinking') {
                contentBlocks[currentBlockIndex] = { type: 'thinking', thinking: '' };
              }
            }

            if (parsed?.type === 'content_block_delta') {
              const idx = parsed.index;
              const delta = parsed.delta;
              if (delta?.type === 'text_delta' && delta.text) {
                if (contentBlocks[idx]) contentBlocks[idx].text += delta.text;
                if (typeof onChunk === 'function') onChunk(delta.text);
              } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                inputJsonBuffer += delta.partial_json;
              } else if (delta?.type === 'thinking_delta' && delta.thinking) {
                if (contentBlocks[idx]) contentBlocks[idx].thinking += delta.thinking;
              }
            }

            if (parsed?.type === 'content_block_stop') {
              const idx = parsed.index;
              if (contentBlocks[idx]?.type === 'tool_use' && inputJsonBuffer) {
                try {
                  contentBlocks[idx].input = JSON.parse(inputJsonBuffer);
                } catch {
                  contentBlocks[idx].input = {};
                }
                inputJsonBuffer = '';
              }
              currentBlockType = null;
            }

            if (parsed?.type === 'message_delta') {
              const nextOutput = Number(parsed?.usage?.output_tokens);
              if (!Number.isNaN(nextOutput)) usage.output_tokens = nextOutput;
            }

            if (parsed?.type === 'message_stop') {
              usage.total_tokens = usage.input_tokens + usage.output_tokens;
              const llmMetrics = this.buildLlmCallMetrics({ model, usage });
              return this.parseToolResponse({ content: contentBlocks }, llmMetrics);
            }
          } catch {
            // Ignore malformed chunks
          }
        }
      }

      usage.total_tokens = usage.input_tokens + usage.output_tokens;
      const llmMetrics = this.buildLlmCallMetrics({ model, usage });
      return this.parseToolResponse({ content: contentBlocks }, llmMetrics);
    });
  }

  parseToolResponse(response, llmMetrics) {
    const content = Array.isArray(response?.content) ? response.content : [];
    const toolUseBlocks = content.filter((block) => block.type === 'tool_use');
    const textBlocks = content.filter((block) => block.type === 'text');
    const thinkingBlocks = content.filter((block) => block.type === 'thinking');

    // Extract thinking content for downstream use (logging, display)
    const thinkingContent = thinkingBlocks.length > 0
      ? thinkingBlocks.map((block) => block.thinking).join('\n')
      : undefined;

    if (toolUseBlocks.length > 0) {
      const toolCalls = toolUseBlocks.map((block) => ({
        toolName: block.name,
        toolUseId: block.id,
        parameters: block.input || {}
      }));

      return {
        type: 'tool_use',
        toolName: toolCalls[0].toolName,
        toolUseId: toolCalls[0].toolUseId,
        parameters: toolCalls[0].parameters,
        toolCalls,
        messageContent: textBlocks.map((block) => block.text).join('\n'),
        thinking: thinkingContent,
        llmMetrics
      };
    }

    return {
      type: 'text',
      content: textBlocks.map((block) => block.text).join('\n'),
      thinking: thinkingContent,
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

  buildMultiToolMessages(response, toolCallEntries) {
    const assistantContent = [];

    if (response.messageContent) {
      assistantContent.push({ type: 'text', text: response.messageContent });
    }

    for (const entry of toolCallEntries) {
      assistantContent.push({
        type: 'tool_use',
        id: entry.toolCallId,
        name: entry.toolName,
        input: entry.parameters || {}
      });
    }

    const toolResults = toolCallEntries.map((entry) => ({
      type: 'tool_result',
      tool_use_id: entry.toolCallId,
      content: JSON.stringify(entry.result)
    }));

    return [
      { role: 'assistant', content: assistantContent },
      { role: 'user', content: toolResults }
    ];
  }

  async streamMessage(messages, options = {}, onChunk) {
    const requestedModel = options.model || this.getDefaultModel();
    const systemPrompt = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
    const cachedSystem = this.buildCachedSystemPrompt(systemPrompt, options.systemPromptDynamic);
    const response = await this.request(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        messages: this.formatMessages(messages),
        ...(cachedSystem ? { system: cachedSystem } : {}),
        max_tokens: options.max_tokens || 4096,
        ...this.temperatureParam(requestedModel, options),
        stream: true
      })
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
    }

    let model = requestedModel;
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    };

    const buildResult = () => ({
      llmMetrics: this.buildLlmCallMetrics({ model, usage })
    });

    return this.guardStream(options, () => ({ model, usage: { ...usage, total_tokens: usage.input_tokens + usage.output_tokens } }), async () => {
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

            if (parsed?.type === 'message_start') {
              model = parsed?.message?.model || model;
              const msgUsage = parsed?.message?.usage;
              if (msgUsage) {
                usage.input_tokens = Number(msgUsage.input_tokens ?? usage.input_tokens) || 0;
                usage.output_tokens = Number(msgUsage.output_tokens ?? usage.output_tokens) || 0;
                usage.cache_creation_input_tokens = Number(msgUsage.cache_creation_input_tokens ?? 0) || 0;
                usage.cache_read_input_tokens = Number(msgUsage.cache_read_input_tokens ?? 0) || 0;
              }
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
    });
  }

  // GET /v1/models pages at 20 by default; the account's full list can run
  // well past that, and a model past page 1 was refused at send time as
  // "not in this account's model list" before this followed has_more/
  // after_id (spec 2026-09-27 §5.1, final review I1).
  async listModels(options = {}) {
    const ids = [];
    let afterId = null;
    for (;;) {
      const url = new URL(`${this.baseUrl}/models`);
      url.searchParams.set('limit', '1000');
      if (afterId) url.searchParams.set('after_id', afterId);
      const response = await this.request(url.toString(), {
        method: 'GET',
        headers: this.getHeaders()
      }, options);

      if (!response.ok) {
        throw await this.buildError(response);
      }

      const data = await response.json();
      const page = Array.isArray(data.data) ? data.data : [];
      for (const model of page) ids.push(model.id);
      if (!data.has_more || page.length === 0) break;
      afterId = data.last_id || page[page.length - 1]?.id;
      if (!afterId) break;
    }
    return ids.sort();
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
module.exports.rejectsTemperature = rejectsTemperature;