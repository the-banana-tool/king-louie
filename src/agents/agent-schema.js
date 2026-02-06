class Agent {
  constructor(config = {}) {
    if (!config.id) {
      throw new Error('Agent id is required');
    }

    this.id = config.id;
    this.name = config.name || config.id;
    this.description = config.description || '';
    this.model = config.model || 'sonnet';
    this.systemPrompt = config.systemPrompt || 'You are a helpful assistant.';
    this.allowedTools = Array.isArray(config.allowedTools) ? config.allowedTools : [];
    this.temperature = typeof config.temperature === 'number' ? config.temperature : 0.7;
    this.maxIterations = Number.isInteger(config.maxIterations) ? config.maxIterations : 10;
  }

  canUseTool(toolName) {
    if (this.allowedTools.includes('*')) return true;
    return this.allowedTools.includes(toolName);
  }

  getSystemMessage() {
    return {
      role: 'system',
      content: this.systemPrompt
    };
  }
}

module.exports = Agent;