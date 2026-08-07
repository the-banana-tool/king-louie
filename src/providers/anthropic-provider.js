const BaseLLMProvider = require('./base-provider');
const ImageHandler = require('../media/image-handler');

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
      'claude-sonnet-4': { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.3 },
      'claude-opus-4': { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.5 },
      'claude-haiku-4': { inputPerMillion: 0.8, outputPerMillion: 4, cacheWritePerMillion: 1, cacheReadPerMillion: 0.08 },
      'claude-3-7-sonnet': { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.3 },
      'claude-3-5-sonnet': { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.3 },
      'claude-3-5-haiku': { inputPerMillion: 0.8, outputPerMillion: 4, cacheWritePerMillion: 1, cacheReadPerMillion: 0.08 },
      'claude-3-opus': { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 18.75, cacheReadPerMillion: 1.5 }
    };
  }

  getDefaultModel() {
    return 'claude-sonnet-4-20250514';
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

  buildCachedSystemPrompt(systemPrompt) {
    if (!systemPrompt) return undefined;

    // If it's already structured blocks, return as-is
    if (Array.isArray(systemPrompt)) return systemPrompt;

    // Single string → wrap in a cached text block
    return [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' }
      }
    ];
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

  /**
   * Calculate cost with Anthropic cache-aware pricing.
   * cache_creation_input_tokens cost 1.25x normal input.
   * cache_read_input_tokens cost 0.1x normal input.
   */
  calculateCostUsd(model, inputTokens, outputTokens, cacheMetrics = {}) {
    const pricing = this.resolveModelPricing(model);
    if (!pricing) return 0;

    // Anthropic reports cache tokens as separate counts (NOT included in
    // input_tokens). Base normalizeUsage maps cache_read_input_tokens →
    // cachedInputTokens and cache_creation_input_tokens → cacheCreationInputTokens.
    const cacheCreation = Number(cacheMetrics.cacheCreationInputTokens || 0);
    const cacheRead = Number(
      cacheMetrics.cachedInputTokens
      ?? cacheMetrics.cacheReadInputTokens
      ?? 0
    );
    // Anthropic's input_tokens does NOT include cache tokens, so no subtraction.
    const uncachedInput = Math.max(0, inputTokens);

    const uncachedCost = (uncachedInput / 1_000_000) * (pricing.inputPerMillion || 0);
    const cacheWriteCost = (cacheCreation / 1_000_000) * (pricing.cacheWritePerMillion || (pricing.inputPerMillion || 0) * 1.25);
    const cacheReadCost = (cacheRead / 1_000_000) * (pricing.cacheReadPerMillion || (pricing.inputPerMillion || 0) * 0.1);
    const outputCost = (outputTokens / 1_000_000) * (pricing.outputPerMillion || 0);

    return Number((uncachedCost + cacheWriteCost + cacheReadCost + outputCost).toFixed(8));
  }

  normalizeUsage(usage = {}) {
    const base = super.normalizeUsage(usage);
    return {
      ...base,
      cacheCreationInputTokens: Number(usage.cache_creation_input_tokens ?? 0) || 0,
      cacheReadInputTokens: Number(usage.cache_read_input_tokens ?? 0) || 0
    };
  }

  buildLlmCallMetrics({ model, usage } = {}) {
    const normalizedModel = model || this.getDefaultModel();
    const normalizedUsage = this.normalizeUsage(usage || {});

    return {
      provider: this.getProviderName(),
      model: normalizedModel,
      ...normalizedUsage,
      costUsd: this.calculateCostUsd(
        normalizedModel,
        normalizedUsage.inputTokens,
        normalizedUsage.outputTokens,
        {
          cacheCreationInputTokens: normalizedUsage.cacheCreationInputTokens,
          cacheReadInputTokens: normalizedUsage.cacheReadInputTokens
        }
      )
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
    const cachedSystem = this.buildCachedSystemPrompt(systemPrompt);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: options.model || this.getDefaultModel(),
        messages: this.formatMessages(messages),
        ...(cachedSystem ? { system: cachedSystem } : {}),
        max_tokens: options.max_tokens || 4096,
        temperature: options.temperature ?? 0.7,
        stream: false
      })
    });

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
    const cachedSystem = this.buildCachedSystemPrompt(systemPrompt);
    const thinking = this.buildThinkingParam(requestedModel, options);

    const body = {
      model: requestedModel,
      messages: this.formatMessages(messages),
      ...(cachedSystem ? { system: cachedSystem } : {}),
      tools: this.buildCachedTools(tools),
      max_tokens: options.max_tokens || 4096,
      stream: false
    };

    // Extended thinking requires temperature=1 and no explicit temperature
    if (thinking) {
      body.thinking = thinking;
      body.temperature = 1;
    } else {
      body.temperature = options.temperature ?? 0.7;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    });

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
    const cachedSystem = this.buildCachedSystemPrompt(systemPrompt);
    const thinking = this.buildThinkingParam(requestedModel, options);

    const body = {
      model: requestedModel,
      messages: this.formatMessages(messages),
      ...(cachedSystem ? { system: cachedSystem } : {}),
      tools: this.buildCachedTools(tools),
      max_tokens: options.max_tokens || 4096,
      stream: true
    };

    if (thinking) {
      body.thinking = thinking;
      body.temperature = 1;
    } else {
      body.temperature = options.temperature ?? 0.7;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw await this.buildError(response);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let model = requestedModel;
    const usage = {
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0
    };

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
    const cachedSystem = this.buildCachedSystemPrompt(systemPrompt);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify({
        model: requestedModel,
        messages: this.formatMessages(messages),
        ...(cachedSystem ? { system: cachedSystem } : {}),
        max_tokens: options.max_tokens || 4096,
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
  }

  async listModels() {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: this.getHeaders()
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
      return body?.error?.message || `${response.status} ${response.statusText}`;
    } catch {
      return `${response.status} ${response.statusText}`;
    }
  }
}

module.exports = AnthropicProvider;