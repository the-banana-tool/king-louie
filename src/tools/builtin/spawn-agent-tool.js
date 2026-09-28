const { Tool } = require('../tool-schema');

// The model that answered the child's last call, from its cost record.
function lastCallModel(result) {
  const calls = Array.isArray(result?.llm?.calls) ? result.llm.calls : [];
  return calls.length ? calls[calls.length - 1]?.model || null : null;
}

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
      role: {
        type: 'string',
        description: 'Which model role runs the sub-agent: "worker" (the default for a plain task: cheaper, good at tool use), "utility" for small mechanical jobs, "main" for hard reasoning, or a custom role from Settings → Models. With agentId and no role, the agent\'s own role applies.'
      },
      model: {
        type: 'string',
        description: 'Rarely needed: one model already in this chat\'s profile, as "provider/model" or its id. Any other model is refused. Prefer role.'
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

    // The role (models spec 2026-09-27 §8): the parameter, else the named
    // agent's own role, else worker.
    const role = typeof params.role === 'string' && params.role.trim()
      ? params.role.trim()
      : (params.agentId ? null : 'worker');
    if (role) executeOptions.role = role;

    // A model the LLM names must already be in the turn's profile (M-D2);
    // the core checks it and refuses anything else.
    if (typeof params.model === 'string' && params.model.trim()) {
      executeOptions.model = params.model.trim();
      executeOptions.requireInProfile = true;
    }

    if (params.systemPromptAppend) {
      executeOptions.systemPrompt = params.systemPromptAppend;
    }

    // If specific tools requested, pass them through
    if (Array.isArray(params.tools) && params.tools.length > 0) {
      executeOptions.toolFilter = params.tools;
    }

    // Bridge approvals back to the parent context (the chat UI that spawned us)
    // so gated tools called by the sub-agent don't silently auto-deny.
    if (typeof options.approvalRequester === 'function') {
      executeOptions.approvalRequester = options.approvalRequester;
    }

    // Cancelling the parent call (a delegate cancel_job) stops the child too.
    if (options.signal) executeOptions.abortSignal = options.signal;

    try {
      const result = await agentExecutorAdapter.execute(
        agent,
        params.task,
        executeOptions
      );

      return {
        success: true,
        agentId,
        role,
        model: lastCallModel(result),
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
