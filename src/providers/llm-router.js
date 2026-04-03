/**
 * LLM-powered model router.
 *
 * Instead of regex/keyword rules, this sends a lightweight classification
 * prompt to a fast model to decide which provider+model best fits the task.
 * Falls back to rule-based routing or tier defaults on error.
 */

const MODEL_CAPABILITIES = {
  'anthropic:claude-sonnet-4-20250514': {
    strengths: ['coding', 'analysis', 'tool-use', 'reasoning', 'instruction-following'],
    context: '200k',
    speed: 'medium',
    cost: 'medium'
  },
  'anthropic:claude-3-opus-latest': {
    strengths: ['deep-reasoning', 'complex-analysis', 'nuanced-writing', 'research'],
    context: '200k',
    speed: 'slow',
    cost: 'high'
  },
  'anthropic:claude-3-5-haiku-latest': {
    strengths: ['speed', 'simple-tasks', 'classification', 'extraction'],
    context: '200k',
    speed: 'fast',
    cost: 'low'
  },
  'openai:gpt-4o': {
    strengths: ['coding', 'vision', 'general-knowledge', 'long-context-recall', 'search'],
    context: '128k',
    speed: 'medium',
    cost: 'medium'
  },
  'openai:gpt-4o-mini': {
    strengths: ['speed', 'simple-tasks', 'classification', 'summarization'],
    context: '128k',
    speed: 'fast',
    cost: 'low'
  },
  'openai:o3-mini': {
    strengths: ['reasoning', 'math', 'logic', 'step-by-step-analysis'],
    context: '128k',
    speed: 'medium',
    cost: 'medium'
  },
  'gemini:gemini-2.0-flash': {
    strengths: ['speed', 'vision', 'multimodal', 'research', 'large-context'],
    context: '1m',
    speed: 'fast',
    cost: 'low'
  },
  'gemini:gemini-2.5-pro-preview-05-06': {
    strengths: ['deep-research', 'reasoning', 'large-context', 'vision', 'coding'],
    context: '1m',
    speed: 'medium',
    cost: 'medium'
  },
  'groq:llama-3.3-70b-versatile': {
    strengths: ['speed', 'simple-tasks', 'chat', 'lightweight-coding'],
    context: '128k',
    speed: 'very-fast',
    cost: 'very-low'
  },
  'xai:grok-3': {
    strengths: ['speed', 'chat', 'current-events', 'creative-writing'],
    context: '128k',
    speed: 'fast',
    cost: 'low'
  },
  'deepseek:deepseek-chat': {
    strengths: ['coding', 'reasoning', 'math', 'cost-efficiency'],
    context: '64k',
    speed: 'medium',
    cost: 'very-low'
  }
};

const CLASSIFICATION_PROMPT = `You are a model router. Given a user message, select the best AI model to handle it.

Available models:
{{modelList}}

User preferences:
- Cost sensitivity: {{costSensitivity}}
- Speed priority: {{speedPriority}}
- Quality priority: {{qualityPriority}}

Respond with ONLY a JSON object — no markdown, no explanation:
{"provider": "<provider>", "model": "<model>", "reason": "<1 sentence why>"}`;

class LLMRouter {
  constructor(options = {}) {
    this.getSettings = options.getSettings;
    this.getProviderToken = options.getProviderToken;
    this.createProvider = options.createProvider;
    this.classifierProvider = options.classifierProvider || null;
    this.classifierModel = options.classifierModel || null;
    this.enabled = false;
    this.cache = new Map();
    this.cacheMaxSize = 200;
    this.cacheTtlMs = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Get available models based on which providers have tokens configured.
   */
  getAvailableModels() {
    const available = {};
    for (const [key, caps] of Object.entries(MODEL_CAPABILITIES)) {
      const [provider] = key.split(':');
      try {
        const token = this.getProviderToken(provider);
        if (token) {
          available[key] = caps;
        }
      } catch {
        // Provider not configured — skip
      }
    }
    return available;
  }

  /**
   * Build the model list string for the classification prompt.
   */
  buildModelList(availableModels) {
    return Object.entries(availableModels)
      .map(([key, caps]) =>
        `- ${key}: strengths=[${caps.strengths.join(', ')}] speed=${caps.speed} cost=${caps.cost} context=${caps.context}`
      )
      .join('\n');
  }

  /**
   * Generate a cache key from the message.
   */
  getCacheKey(message) {
    // Use first 200 chars + length as key to catch similar messages
    const normalized = message.trim().toLowerCase().slice(0, 200);
    return `${normalized.length}:${normalized}`;
  }

  /**
   * Classify a message and return the best provider+model.
   * Returns null if classification fails (caller should fall back).
   */
  async classify(message, context = {}) {
    // Check cache first
    const cacheKey = this.getCacheKey(message);
    const cached = this.cache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < this.cacheTtlMs) {
      return cached.result;
    }

    const availableModels = this.getAvailableModels();
    if (Object.keys(availableModels).length === 0) {
      return null;
    }

    const settings = this.getSettings();
    const llmRouting = settings?.inference?.llmRouting || {};

    const prompt = CLASSIFICATION_PROMPT
      .replace('{{modelList}}', this.buildModelList(availableModels))
      .replace('{{costSensitivity}}', llmRouting.costSensitivity || 'medium')
      .replace('{{speedPriority}}', llmRouting.speedPriority || 'medium')
      .replace('{{qualityPriority}}', llmRouting.qualityPriority || 'high');

    // Use a fast, cheap model for classification
    let classifierProvider = this.classifierProvider;
    let classifierModel = this.classifierModel;

    if (!classifierProvider) {
      // Auto-select: prefer groq for speed, fall back to whatever's available
      const preferredClassifiers = ['groq', 'openai', 'anthropic', 'gemini'];
      for (const p of preferredClassifiers) {
        try {
          const token = this.getProviderToken(p);
          if (token) {
            classifierProvider = this.createProvider(p, token);
            classifierModel = p === 'groq' ? 'llama-3.3-70b-versatile'
              : p === 'openai' ? 'gpt-4o-mini'
              : p === 'anthropic' ? 'claude-3-5-haiku-latest'
              : 'gemini-2.0-flash';
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!classifierProvider) {
      return null;
    }

    try {
      const messages = [
        { role: 'system', content: prompt },
        { role: 'user', content: message.slice(0, 500) } // Truncate for classification
      ];

      const response = await classifierProvider.sendMessage(messages, {
        model: classifierModel,
        temperature: 0,
        max_tokens: 100
      });

      const responseText = typeof response === 'string' ? response : response?.content || '';
      const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.provider || !parsed.model) return null;

      // Verify the selected model is actually available
      const key = `${parsed.provider}:${parsed.model}`;
      if (!availableModels[key]) {
        // Try partial match
        const match = Object.keys(availableModels).find((k) =>
          k.startsWith(`${parsed.provider}:`) && k.includes(parsed.model.split('-')[0])
        );
        if (!match) return null;
        const [matchProvider, matchModel] = match.split(':');
        parsed.provider = matchProvider;
        parsed.model = matchModel;
      }

      const result = {
        provider: parsed.provider,
        model: parsed.model,
        reason: parsed.reason || ''
      };

      // Cache the result
      if (this.cache.size >= this.cacheMaxSize) {
        const oldest = this.cache.keys().next().value;
        this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, { result, timestamp: Date.now() });

      return result;
    } catch {
      return null;
    }
  }
}

module.exports = LLMRouter;
