class AgentOrchestrator {
  constructor(agentExecutor) {
    this.agentExecutor = agentExecutor;
  }

  async executeParallel(agents, message, options = {}) {
    const executions = (agents || []).map((agent) =>
      this.agentExecutor.execute(agent, message, options)
    );

    return Promise.all(executions);
  }

  async executeSerial(agents, initialMessage, options = {}) {
    const results = [];
    let currentMessage = initialMessage;

    for (const agent of agents || []) {
      const result = await this.agentExecutor.execute(agent, currentMessage, options);
      results.push(result);
      currentMessage = result?.content || currentMessage;
    }

    return results;
  }

  async executeWithDependencies(taskManager, agents, options = {}) {
    const agentById = new Map((agents || []).map((agent) => [agent.id, agent]));
    const results = new Map();

    while (true) {
      const availableTasks = taskManager.getAvailableTasks();
      if (!availableTasks.length) {
        break;
      }

      await Promise.all(
        availableTasks.map(async (task) => {
          const agent = agentById.get(task?.metadata?.agentId || '');
          if (!agent) {
            taskManager.update(task.id, {
              status: 'deleted',
              metadata: {
                ...(task.metadata || {}),
                error: `No agent mapped for task ${task.id}`
              }
            });
            return;
          }

          taskManager.markInProgress(task.id);

          try {
            const result = await this.agentExecutor.execute(agent, task.description, options);
            results.set(task.id, result);
            taskManager.markCompleted(task.id);
          } catch (error) {
            taskManager.update(task.id, {
              status: 'pending',
              metadata: {
                ...(task.metadata || {}),
                error: error.message
              }
            });
          }
        })
      );
    }

    return results;
  }
}

module.exports = AgentOrchestrator;