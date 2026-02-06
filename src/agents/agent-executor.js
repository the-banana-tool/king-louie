const AgentLoop = require('../execution/agent-loop');

class AgentExecutor {
  constructor(provider, toolExecutor) {
    this.provider = provider;
    this.toolExecutor = toolExecutor;
  }

  async execute(agent, userMessage, options = {}) {
    if (!agent) {
      throw new Error('Agent is required');
    }

    const baseMessages = Array.isArray(options.messages)
      ? [...options.messages]
      : [
          agent.getSystemMessage(),
          { role: 'user', content: userMessage }
        ];

    const candidateTools = Array.isArray(options.tools) ? options.tools : [];
    const availableTools = candidateTools.filter((tool) => agent.canUseTool(tool.name));

    const loop = new AgentLoop(this.provider, this.toolExecutor, {
      maxIterations: options.maxIterations || agent.maxIterations
    });

    const combinedSystemPrompt = [agent.systemPrompt, options.systemPrompt]
      .filter((value) => typeof value === 'string' && value.trim())
      .join('\n\n');

    return loop.run(baseMessages, availableTools, {
      ...options,
      temperature: options.temperature ?? agent.temperature,
      model: options.model || agent.model,
      systemPrompt: combinedSystemPrompt || undefined
    });
  }
}

module.exports = AgentExecutor;