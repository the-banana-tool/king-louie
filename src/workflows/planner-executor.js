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
      maxIterations: options.maxIterations || plannerAgent.maxIterations || 40
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
      const err = new Error(`Planning failed: ${result.content}`);
      err.plannerOutput = result.content || '';
      err.goal = goal;
      throw err;
    }

    if (result.type === 'max_iterations') {
      const toolSummary = Array.isArray(result.tools) && result.tools.length
        ? `\n\nTools used (${result.tools.length}):\n${result.tools.map((t) => `- ${t.toolName || t.name || 'unknown'}`).join('\n')}`
        : '';
      const err = new Error(
        `Planner hit the iteration cap (${execOptions.maxIterations}) before producing a task graph. Try a narrower goal, or increase the cap.`
      );
      err.plannerOutput = (result.content || '') + toolSummary;
      err.goal = goal;
      throw err;
    }

    return this._parseTaskGraph(result.content, goal);
  }

  /**
   * Parse the planner agent's output into a structured task graph.
   *
   * If the planner did not produce valid JSON with at least one task, this
   * throws a PlannerOutputError carrying the planner's raw text so the UI
   * can show the user what the planner actually said (a clarifying question,
   * a refusal, an explanation of why the goal is ambiguous, etc.) instead
   * of silently fabricating a single "Execute goal directly" pseudo-task.
   */
  _parseTaskGraph(content, originalGoal) {
    const rawContent = typeof content === 'string' ? content : String(content || '');

    const jsonMatch = rawContent.match(/```json\s*([\s\S]*?)```/) || rawContent.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) {
      const err = new Error(
        'Planner did not emit a JSON task graph. It likely asked a clarifying question or decided the goal was ambiguous.'
      );
      err.plannerOutput = rawContent;
      err.goal = originalGoal;
      throw err;
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
    } catch (parseErr) {
      const err = new Error(`Planner produced malformed JSON: ${parseErr.message}`);
      err.plannerOutput = rawContent;
      err.goal = originalGoal;
      throw err;
    }

    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
      const err = new Error('Planner produced an empty task graph (no tasks).');
      err.plannerOutput = rawContent;
      err.goal = originalGoal;
      throw err;
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
      const err = new Error('Task graph has circular dependencies');
      err.plannerOutput = rawContent;
      err.goal = originalGoal;
      throw err;
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
