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
  }

  /**
   * Plan and execute a goal end-to-end.
   * Returns the workflow object (which may still be running).
   */
  async planAndExecute(goal, options = {}) {
    // Phase 1: Plan
    const taskGraph = await this.plan(goal, options);

    // Phase 2: Create workflow
    const workflow = await this.workflowEngine.create(taskGraph);

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
   */
  async plan(goal, options = {}) {
    const plannerAgent = this.getAgent('planner');
    if (!plannerAgent) {
      throw new Error('Planner agent not found. Ensure it is registered.');
    }

    const result = await this.agentExecutorAdapter.execute(plannerAgent, goal, {
      maxIterations: options.maxIterations || 15
    });

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
