const BaseLLMProvider = require('./base-provider');
const ImageHandler = require('../media/image-handler');

class GeminiProvider extends BaseLLMProvider {
  constructor(apiKey) {
    super(apiKey);
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  }

  getName() { return 'gemini'; }
  getLabel() { return 'Google Gemini'; }

  getProviderName() {
    return 'gemini';
  }

  getModels() {
    return [
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', contextWindow: 1048576 },
      { id: 'gemini-2.0-pro', name: 'Gemini 2.0 Pro', contextWindow: 1048576 },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', contextWindow: 1048576 },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', contextWindow: 2097152 }
    ];
  }

  getDefaultModel() {
    return 'gemini-2.0-flash';
  }

  getModelPricingTable() {
    return {
      'gemini-2.0-flash': { inputPerMillion: 0.10, outputPerMillion: 0.40 },
      'gemini-2.0-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00 },
      'gemini-1.5-flash': { inputPerMillion: 0.075, outputPerMillion: 0.30 },
      'gemini-1.5-pro': { inputPerMillion: 1.25, outputPerMillion: 5.00 }
    };
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
            } catch (err) { console.debug('[gemini] function args parse failed:', err.message); args = {}; }
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
    return [{
      functionDeclarations: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
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
      options.systemPrompt
        ? [{ role: 'system', content: options.systemPrompt }, ...messages]
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

    const response = await fetch(this.getApiUrl(model), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    return candidate?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
  }

  async sendMessageWithTools(messages, tools = [], options = {}) {
    const requestedModel = options.model || this.getDefaultModel();
    const { contents, systemInstruction } = this.formatMessages(
      options.systemPrompt
        ? [{ role: 'system', content: options.systemPrompt }, ...messages]
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

    const response = await fetch(this.getApiUrl(requestedModel), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
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
      options.systemPrompt
        ? [{ role: 'system', content: options.systemPrompt }, ...messages]
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

    const response = await fetch(this.getApiUrl(requestedModel, true), {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage = null;

    const buildResult = () => ({
      llmMetrics: this.buildLlmCallMetrics({ model: requestedModel, usage })
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
  }

  async listModels() {
    const response = await fetch(`${this.baseUrl}/models?key=${this.apiKey}`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(await this.extractError(response));
    }

    const data = await response.json();
    return (data.models || [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .sort();
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
