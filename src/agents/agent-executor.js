const AgentLoop = require('../execution/agent-loop');
const path = require('path');
const TemplateEngine = require('../templates/template-engine');

class AgentExecutor {
  constructor(provider, toolExecutor, options = {}) {
    this.provider = provider;
    this.toolExecutor = toolExecutor;
    this.usageTracker = options.usageTracker || null;
    this.onUsageRecorded = typeof options.onUsageRecorded === 'function'
      ? options.onUsageRecorded
      : null;
    this.templateEngine = new TemplateEngine({
      templatesDirectory: path.join(process.cwd(), 'templates')
    });
  }

  resolveTemplateContext(agent, options = {}, userMessage = '') {
    const baseContext = {
      now: new Date().toISOString(),
      userMessage,
      agent: {
        id: agent?.id,
        name: agent?.name,
        description: agent?.description,
        model: agent?.model,
        inferenceTier: agent?.inferenceTier,
        allowedTools: Array.isArray(agent?.allowedTools) ? agent.allowedTools.join(', ') : ''
      }
    };

    if (options.templateContext && typeof options.templateContext === 'object') {
      return {
        ...baseContext,
        ...options.templateContext,
        agent: {
          ...baseContext.agent,
          ...(options.templateContext.agent || {})
        }
      };
    }

    return baseContext;
  }

  resolveAgentSystemPrompt(agent, options = {}, userMessage = '') {
    if (agent?.systemPromptTemplate) {
      try {
        return this.templateEngine.renderFile(agent.systemPromptTemplate, this.resolveTemplateContext(agent, options, userMessage));
      } catch (error) {
        console.warn(`[agent-executor] Failed to render template for agent '${agent.id}':`, error.message);
      }
    }

    return agent?.systemPrompt || '';
  }

  async execute(agent, userMessage, options = {}) {
    if (!agent) {
      throw new Error('Agent is required');
    }

    const baseMessages = Array.isArray(options.messages)
      ? [...options.messages]
      : [{ role: 'user', content: userMessage }];

    const candidateTools = Array.isArray(options.tools) ? options.tools : [];
    const availableTools = candidateTools.filter((tool) => agent.canUseTool(tool.name));

    const loop = new AgentLoop(this.provider, this.toolExecutor, {
      maxIterations: options.maxIterations || agent.maxIterations,
      usageTracker: this.usageTracker,
      onUsageRecorded: this.onUsageRecorded
    });

    const combinedSystemPrompt = [this.resolveAgentSystemPrompt(agent, options, userMessage), options.systemPrompt]
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