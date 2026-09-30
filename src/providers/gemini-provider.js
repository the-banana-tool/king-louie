const BaseLLMProvider = require('./base-provider');
const ImageHandler = require('../media/image-handler');
const { createLogger } = require('../logging');
const log = createLogger('gemini');

class GeminiProvider extends BaseLLMProvider {
  constructor(apiKey, options = {}) {
    super(apiKey, options);
    this.baseUrl = BaseLLMProvider.baseUrlFrom(options, 'https://generativelanguage.googleapis.com/v1beta');
  }

  getName() { return 'gemini'; }
  getLabel() { return 'Google Gemini'; }

  getProviderName() {
    return 'gemini';
  }

  getModels() {
    return [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576 },
      { id: 'gemini-2.0-pro', name: 'Gemini 2.0 Pro', contextWindow: 1048576 },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', contextWindow: 1048576 },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', contextWindow: 2097152 }
    ];
  }

  getDefaultModel() {
    return 'gemini-2.5-flash';
  }

  getHeaders() {
    return {
      'Content-Type': 'application/json'
    };
  }

  getApiUrl(model, stream = false) {
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    const params = stream ? `alt=sse&key=${this.apiKey}` : `key=${this.apiKey}`;
    return `${this.baseUrl}/models/${model}:${action}?${params}`;
  }

  formatMessages(chatHistory) {
    const messages = [];
    let systemInstruction = null;

    const buildParts = (text, images = [], documents = []) => {
      const parts = [];
      if (typeof text === 'string' && text.trim()) {
        parts.push({ text });
      }

      if (Array.isArray(documents) && documents.length > 0) {
        const docParts = ImageHandler.normalizeMessageDocuments(documents).map((doc) =>
          ImageHandler.formatDocumentForProvider('gemini', doc)
        );
        docParts.forEach((part) => {
          if (part.type === 'text') {
            parts.push({ text: part.text });
          } else if (part.inlineData) {
            parts.push(part);
          }
        });
      }

      if (Array.isArray(images) && images.length > 0) {
        const imageParts = ImageHandler.normalizeMessageImages(images).map((image) =>
          ImageHandler.formatForProvider('gemini', image)
        );
        parts.push(...imageParts);
      }

      if (parts.length === 0) {
        parts.push({ text: '' });
      }

      return parts;
    };

    for (const msg of (chatHistory || [])) {
      if (!msg) continue;

      const role = msg.role || (msg.sender === 'assistant' ? 'assistant' : 'user');
      const text = msg.content ?? msg.text ?? '';

      if (role === 'system') {
        systemInstruction = text;
        continue;
      }

      if (role === 'tool') {
        messages.push({
          role: 'function',
          parts: [{
            functionResponse: {
              name: msg.tool_name || 'tool',
              response: { result: text }
            }
          }]
        });
        continue;
      }

      if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
        const parts = [];
        if (text) parts.push({ text });
        for (const call of msg.tool_calls) {
          if (call.type === 'function' && call.function) {
            let args = {};
            try {
              args = typeof call.function.arguments === 'string'
                ? JSON.parse(call.function.arguments)
                : call.function.arguments || {};
            } catch (err) { log.debug(`function args parse failed: ${err.message}`); args = {}; }
            parts.push({
              functionCall: {
                name: call.function.name,
                args
              }
            });
          }
        }
        messages.push({ role: 'model', parts });
        continue;
      }

      messages.push({
        role: role === 'assistant' ? 'model' : 'user',
        parts: Array.isArray(msg.content) ? msg.content : buildParts(text, msg.images, msg.documents)
      });
    }

    return { contents: messages, systemInstruction };
  }

  formatTools(tools) {
    if (!tools || tools.length === 0) return undefined;
    // Gemini refuses an object schema with no properties; a tool that takes
    // no arguments (list_cases, get_presence) declares no parameters instead.
    const takesArgs = (p) => Boolean(p) && !(p.type === 'object' && Object.keys(p.properties || {}).length === 0);
    return [{
      functionDeclarations: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        ...(takesArgs(tool.parameters) ? { parameters: tool.parameters } : {})
      }))
    }];
  }

  parseToolCalls(candidate) {
    const parts = candidate?.content?.parts || [];
    return parts
      .filter(p => p.functionCall)
      .map(p => ({
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        name: p.functionCall.name,
        arguments: p.functionCall.args || {}
      }));
  }

  async sendMessage(messages, options = {}) {
    const model = options.model || this.getDefaultModel();
    const { contents, systemInstruction } = this.formatMessages(
      this.systemText(options)
        ? [{ role: 'system', content: this.systemText(options) }, ...messages]
        : messages
    );

    const body = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.7
      }
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const response = await this.request(this.getApiUrl(model), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    return candidate?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  }

  async sendMessageWithTools(messages, tools = [], options = {}) {
    const requestedModel = options.model || this.getDefaultModel();
    const { contents, systemInstruction } = this.formatMessages(
      this.systemText(options)
        ? [{ role: 'system', content: this.systemText(options) }, ...messages]
        : messages
    );

    const body = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.7
      }
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    const formattedTools = this.formatTools(tools);
    if (formattedTools) {
      body.tools = formattedTools;
    }

    const response = await this.request(this.getApiUrl(requestedModel), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];

    const usage = data.usageMetadata ? {
      prompt_tokens: data.usageMetadata.promptTokenCount || 0,
      completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
      total_tokens: data.usageMetadata.totalTokenCount || 0
    } : {};

    const llmMetrics = this.buildLlmCallMetrics({
      model: requestedModel,
      usage
    });

    const parsedToolCalls = this.parseToolCalls(candidate);
    if (parsedToolCalls.length > 0) {
      const toolCalls = parsedToolCalls.map((call) => ({
        toolName: call.name,
        toolUseId: call.id,
        parameters: call.arguments
      }));

      return {
        type: 'tool_use',
        toolName: toolCalls[0].toolName,
        toolUseId: toolCalls[0].toolUseId,
        parameters: toolCalls[0].parameters,
        toolCalls,
        messageContent: candidate?.content?.parts?.filter(p => p.text).map(p => p.text).join('') || '',
        llmMetrics
      };
    }

    return {
      type: 'text',
      content: candidate?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '',
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
        tool_name: response.toolName,
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
        tool_name: entry.toolName,
        content: JSON.stringify(entry.result)
      });
    }

    return messages;
  }

  async streamMessage(messages, options = {}, onChunk) {
    const requestedModel = options.model || this.getDefaultModel();
    const { contents, systemInstruction } = this.formatMessages(
      this.systemText(options)
        ? [{ role: 'system', content: this.systemText(options) }, ...messages]
        : messages
    );

    const body = {
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.7
      }
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const response = await this.request(this.getApiUrl(requestedModel, true), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    }, options);

    if (!response.ok) {
      throw await this.buildError(response);
    }

    let usage = null;

    const buildResult = () => ({
      llmMetrics: this.buildLlmCallMetrics({ model: requestedModel, usage })
    });

    return this.guardStream(options, () => ({ model: requestedModel, usage }), async () => {
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
            if (parsed?.usageMetadata) {
              usage = {
                prompt_tokens: parsed.usageMetadata.promptTokenCount || 0,
                completion_tokens: parsed.usageMetadata.candidatesTokenCount || 0,
                total_tokens: parsed.usageMetadata.totalTokenCount || 0
              };
            }

            const parts = parsed.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.text) onChunk(part.text);
            }
          } catch {
            // Ignore malformed partial chunks
          }
        }
      }

      return buildResult();
    });
  }

  // models.list pages at 50 by default; the account's full list can run
  // well past that, and a model past page 1 was refused at send time as
  // "not in this account's model list" before this followed nextPageToken
  // (spec 2026-09-27 §5.1, final review I1).
  async listModels(options = {}) {
    const ids = [];
    let pageToken = null;
    for (;;) {
      const url = new URL(`${this.baseUrl}/models`);
      url.searchParams.set('key', this.apiKey);
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const response = await this.request(url.toString(), {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      }, options);

      if (!response.ok) {
        throw await this.buildError(response);
      }

      const data = await response.json();
      for (const m of (data.models || [])) {
        if (m.supportedGenerationMethods?.includes('generateContent')) ids.push(m.name.replace('models/', ''));
      }
      pageToken = data.nextPageToken || null;
      if (!pageToken) break;
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

module.exports = GeminiProvider;
