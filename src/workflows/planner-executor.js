/**
 * Planner Executor — the glue between the planner agent and the workflow engine.
 *
 * Takes a high-level goal, runs the planner agent to produce a task graph,
 * then feeds that graph into the WorkflowEngine for durable execution.
 */

class PlannerExecutor {
  constructor(options = {}) {
    this.agentExecutorAdapter = options.agentExecutorAdapter;
    this.workflowEngine = options.workflowEngine;
    this.getAgent = options.getAgent;
    // Optional: semantic conversation compactor. When provided and the chat
    // history exceeds its threshold, the planner receives a semantically
    // retrieved subset instead of the full transcript.
    this.getConversationCompactor = typeof options.getConversationCompactor === 'function'
      ? options.getConversationCompactor
      : () => null;
  }

  /**
   * Plan and execute a goal end-to-end.
   * Returns the workflow object (which may still be running).
   */
  async planAndExecute(goal, options = {}) {
    // Phase 1: Plan
    const taskGraph = await this.plan(goal, options);

    // Phase 2: Create workflow (carry chatId + workingDirectory so events and task
    // execution are rooted in the chat that launched the workflow)
    const workflow = await this.workflowEngine.create(taskGraph, {
      chatId: options.chatId || null,
      workingDirectory: options.workingDirectory || null
    });

    // Phase 3: Execute (async — returns immediately if background)
    if (options.background) {
      // Fire and forget — caller can poll getProgress()
      this.workflowEngine.run(workflow.id).catch((err) => {
        console.error(`[planner-executor] Background workflow ${workflow.id} error:`, err.message);
      });
      return workflow;
    }

    // Synchronous execution — wait for completion
    return this.workflowEngine.run(workflow.id);
  }

  /**
   * Run only the planning phase — returns the task graph without executing it.
   *
   * Supported options:
   *   - workingDirectory: project root; rooted for the planner's Read/Glob/Grep tools
   *     AND injected into the system prompt so the planner cites real paths.
   *   - chatMessages: array of {sender, text} chat history; converted to
   *     {role, content} and passed as `messages` so the planner sees the full
   *     conversation context (the goal alone is often not enough).
   *   - maxIterations: override default 15.
   *   - chatId: carried through for event association (not used during planning).
   */
  async plan(goal, options = {}) {
    const plannerAgent = this.getAgent('planner');
    if (!plannerAgent) {
      throw new Error('Planner agent not found. Ensure it is registered.');
    }

    const execOptions = {
      maxIterations: options.maxIterations || 15
    };

    if (options.workingDirectory) {
      execOptions.workingDirectory = options.workingDirectory;
      execOptions.systemPrompt = [
        `Working directory (project root for this plan): ${options.workingDirectory}`,
        'All file paths in your task descriptions MUST be absolute and rooted under this directory unless the goal explicitly requires otherwise.',
        'Your Read/Glob/Grep tool calls are already rooted in this directory — use them.'
      ].join('\n');
    }

    let history = Array.isArray(options.chatMessages) ? options.chatMessages : [];
    history = history.filter((m) => m && (m.sender === 'user' || m.sender === 'assistant'));

    // Semantic compaction: if history is large, retrieve only the chunks
    // relevant to the goal instead of replaying the whole transcript.
    const compactor = this.getConversationCompactor();
    if (compactor && history.length > 0 && typeof compactor.shouldCompact === 'function' && compactor.shouldCompact(history)) {
      try {
        history = await compactor.retrieve(goal, history, {
          maxChunks: 20,
          alwaysKeepRecent: 4,
          minSimilarity: 0.25,
          maxTokens: 4000
        });
      } catch (err) {
        console.warn('[planner-executor] Conversation compaction failed, using full history:', err.message);
      }
    }

    const convertedHistory = history
      .map((m) => ({
        role: m.sender === 'assistant' ? 'assistant' : 'user',
        content: typeof m.text === 'string' ? m.text : String(m.text || '')
      }))
      .filter((m) => m.content.trim().length > 0);

    if (convertedHistory.length > 0) {
      // Append the explicit goal as the final user turn so the planner knows
      // what to produce a plan for.
      execOptions.messages = [
        ...convertedHistory,
        { role: 'user', content: `Produce a task graph for this goal:\n\n${goal}` }
      ];
    }

    const result = await this.agentExecutorAdapter.execute(plannerAgent, goal, execOptions);

    if (result.type === 'error' || result.type === 'stopped') {
      throw new Error(`Planning failed: ${result.content}`);
    }

    return this._parseTaskGraph(result.content, goal);
  }

  /**
   * Parse the planner agent's output into a structured task graph.
   */
  _parseTaskGraph(content, originalGoal) {
    // Extract JSON from the response
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      // If planner didn't output JSON, create a single-task fallback
      return {
        goal: originalGoal,
        summary: 'Direct execution (planner did not produce a structured plan)',
        tasks: [{
          id: 'task-1',
          title: 'Execute goal directly',
          description: `${originalGoal}\n\nPlanner context:\n${content}`,
          agentId: 'main',
          dependsOn: [],
          priority: 1,
          estimatedComplexity: 'medium'
        }],
        parallelGroups: [],
        estimatedTotalSteps: 1
      };
    }

    try {
      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);

      // Validate minimum structure
      if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
        throw new Error('Task graph has no tasks');
      }

      // Ensure all tasks have required fields
      for (const task of parsed.tasks) {
        if (!task.id) task.id = `task-${Math.random().toString(36).slice(2, 8)}`;
        if (!task.description) task.description = task.title || 'No description';
        if (!task.agentId) task.agentId = 'main';
        if (!Array.isArray(task.dependsOn)) task.dependsOn = [];
      }

      // Validate dependency references
      const taskIds = new Set(parsed.tasks.map((t) => t.id));
      for (const task of parsed.tasks) {
        task.dependsOn = task.dependsOn.filter((depId) => taskIds.has(depId));
      }

      // Detect circular dependencies
      if (this._hasCycle(parsed.tasks)) {
        throw new Error('Task graph has circular dependencies');
      }

      return {
        goal: parsed.goal || originalGoal,
        summary: parsed.summary || '',
        tasks: parsed.tasks,
        parallelGroups: parsed.parallelGroups || [],
        estimatedTotalSteps: parsed.estimatedTotalSteps || parsed.tasks.length,
        requiresUserInput: parsed.requiresUserInput || false,
        userInputNeeded: parsed.userInputNeeded || null
      };
    } catch (error) {
      if (error.message.includes('circular')) throw error;

      // JSON parse failed — fallback to single task
      return {
        goal: originalGoal,
        summary: 'Direct execution (could not parse planner output)',
        tasks: [{
          id: 'task-1',
          title: 'Execute goal directly',
          description: `${originalGoal}\n\nPlanner context:\n${content}`,
          agentId: 'main',
          dependsOn: [],
          priority: 1,
          estimatedComplexity: 'medium'
        }],
        parallelGroups: [],
        estimatedTotalSteps: 1
      };
    }
  }

  /**
   * Detect cycles in the task dependency graph using DFS.
   */
  _hasCycle(tasks) {
    const visited = new Set();
    const inStack = new Set();
    const adjacency = new Map();

    for (const task of tasks) {
      adjacency.set(task.id, task.dependsOn || []);
    }

    const dfs = (nodeId) => {
      if (inStack.has(nodeId)) return true;
      if (visited.has(nodeId)) return false;
      visited.add(nodeId);
      inStack.add(nodeId);
      for (const dep of adjacency.get(nodeId) || []) {
        if (dfs(dep)) return true;
      }
      inStack.delete(nodeId);
      return false;
    };

    for (const task of tasks) {
      if (dfs(task.id)) return true;
    }
    return false;
  }
}

module.exports = PlannerExecutor;
