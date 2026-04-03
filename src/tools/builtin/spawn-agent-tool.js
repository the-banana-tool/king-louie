const { Tool } = require('../tool-schema');

const SpawnAgentTool = new Tool({
  name: 'SpawnAgent',
  description: `Dynamically spawn a sub-agent to handle a specific subtask during execution.
The sub-agent runs independently with its own agent loop and returns a result.
Use this to delegate work that requires a different specialization, model, or tool set.

The spawned agent inherits the current working directory and allowed directories but runs
in its own conversation context. Results are returned inline to the calling agent.`,

  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The task/instruction for the sub-agent to execute'
      },
      agentId: {
        type: 'string',
        description: 'Which built-in agent to use: "main", "code-explorer", "code-writer", "planner". Defaults to "main".'
      },
      model: {
        type: 'string',
        description: 'Override the model for this sub-agent (e.g., "gemini-2.0-flash", "gpt-4o", "claude-sonnet-4-20250514"). Uses the agent default if not specified.'
      },
      provider: {
        type: 'string',
        description: 'Override the provider for this sub-agent (e.g., "openai", "anthropic", "gemini", "groq"). Uses default routing if not specified.'
      },
      maxIterations: {
        type: 'number',
        description: 'Maximum tool iterations for the sub-agent (default: 10)',
        minimum: 1,
        maximum: 50
      },
      systemPromptAppend: {
        type: 'string',
        description: 'Additional instructions to append to the sub-agent system prompt'
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict the sub-agent to only these tools (e.g., ["Read", "Grep", "Bash"]). Defaults to agent allowedTools.'
      }
    },
    required: ['task']
  },

  requiresApproval: false,

  async execute(params, options = {}) {
    const {
      agentExecutorAdapter,
      getAgent,
      listAgents,
      toolRegistry,
      inferenceRouter
    } = options;

    if (!agentExecutorAdapter) {
      return {
        success: false,
        error: 'SpawnAgent requires agentExecutorAdapter in execution options. Agent infrastructure may not be initialized.'
      };
    }

    if (typeof getAgent !== 'function') {
      return {
        success: false,
        error: 'SpawnAgent requires getAgent function in execution options.'
      };
    }

    const agentId = params.agentId || 'main';
    const agent = getAgent(agentId);

    if (!agent) {
      const available = typeof listAgents === 'function'
        ? listAgents().map((a) => a.id).join(', ')
        : 'main, code-explorer, code-writer, planner';
      return {
        success: false,
        error: `Unknown agent "${agentId}". Available agents: ${available}`
      };
    }

    const executeOptions = {};

    if (params.maxIterations) {
      executeOptions.maxIterations = params.maxIterations;
    }

    if (params.model) {
      executeOptions.model = params.model;
    }

    if (params.systemPromptAppend) {
      executeOptions.systemPrompt = params.systemPromptAppend;
    }

    // If specific tools requested, pass them through
    if (Array.isArray(params.tools) && params.tools.length > 0) {
      executeOptions.toolFilter = params.tools;
    }

    // If a provider override is specified, pass it through
    if (params.provider) {
      executeOptions.provider = params.provider;
    }

    try {
      const result = await agentExecutorAdapter.execute(
        agent,
        params.task,
        executeOptions
      );

      return {
        success: true,
        agentId,
        model: params.model || agent.model,
        iterations: result.iterations || 0,
        type: result.type,
        content: result.content || '',
        toolsUsed: (result.tools || []).map((t) => t.name),
        llm: result.llm?.totals || null
      };
    } catch (error) {
      return {
        success: false,
        agentId,
        error: `Sub-agent execution failed: ${error.message}`
      };
    }
  }
});

module.exports = SpawnAgentTool;
