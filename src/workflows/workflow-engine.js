const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Durable workflow engine for multi-session task execution.
 *
 * A workflow is a task graph (produced by the planner agent) that persists
 * across sessions. The engine manages lifecycle, state checkpointing,
 * and resumption of long-running workflows.
 */

const WORKFLOW_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

const TASK_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  SKIPPED: 'skipped'
};

class WorkflowEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.storageDir = options.storageDir || path.join(
      options.userDataPath || process.cwd(),
      'workflows'
    );
    this.agentExecutorAdapter = options.agentExecutorAdapter || null;
    this.getAgent = options.getAgent || null;
    this.maxConcurrentTasks = options.maxConcurrentTasks || 3;
    // Optional: parent-chat context injection for each task. When both are
    // provided, _executeTask pulls the parent chat's history, semantically
    // compacts it using the task description as the query, and prepends it to
    // the task's messages so the executor has the user's surrounding context.
    this.getConversationCompactor = typeof options.getConversationCompactor === 'function'
      ? options.getConversationCompactor
      : () => null;
    this.getParentChatMessages = typeof options.getParentChatMessages === 'function'
      ? options.getParentChatMessages
      : () => [];
    this.workflows = new Map();
    this.activeExecutions = new Map(); // workflowId → AbortController
  }

  async initialize() {
    await fs.promises.mkdir(this.storageDir, { recursive: true });
    await this._loadAll();
  }

  /**
   * Create a workflow from a planner task graph.
   */
  async create(taskGraph, opts = {}) {
    if (!taskGraph || !Array.isArray(taskGraph.tasks)) {
      throw new Error('Invalid task graph: must have a tasks array');
    }

    const id = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const workflow = {
      id,
      goal: taskGraph.goal || '',
      summary: taskGraph.summary || '',
      status: WORKFLOW_STATUS.PENDING,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      tasks: taskGraph.tasks.map((t) => ({
        id: t.id,
        title: t.title || '',
        description: t.description || '',
        agentId: t.agentId || 'main',
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn : [],
        priority: t.priority || 999,
        status: TASK_STATUS.PENDING,
        preferredModel: t.preferredModel || null,
        tools: Array.isArray(t.tools) ? t.tools : [],
        estimatedComplexity: t.estimatedComplexity || 'medium',
        result: null,
        error: null,
        startedAt: null,
        completedAt: null,
        iterations: 0,
        llm: null
      })),
      parallelGroups: taskGraph.parallelGroups || [],
      metadata: {
        estimatedTotalSteps: taskGraph.estimatedTotalSteps || taskGraph.tasks.length,
        requiresUserInput: taskGraph.requiresUserInput || false,
        userInputNeeded: taskGraph.userInputNeeded || null,
        chatId: opts.chatId || null,
        workingDirectory: opts.workingDirectory || null
      }
    };

    this.workflows.set(id, workflow);
    await this._save(workflow);
    this.emit('workflow:created', { workflowId: id, goal: workflow.goal, chatId: workflow.metadata.chatId });

    return workflow;
  }

  /**
   * Start or resume a workflow.
   */
  async run(workflowId) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new Error(`Workflow ${workflowId} not found`);

    if (!this.agentExecutorAdapter || typeof this.agentExecutorAdapter.execute !== 'function') {
      throw new Error('WorkflowEngine requires agentExecutorAdapter to run workflows');
    }

    if (workflow.status === WORKFLOW_STATUS.COMPLETED || workflow.status === WORKFLOW_STATUS.CANCELLED) {
      throw new Error(`Workflow ${workflowId} is already ${workflow.status}`);
    }

    const abortController = new AbortController();
    this.activeExecutions.set(workflowId, abortController);

    workflow.status = WORKFLOW_STATUS.RUNNING;
    workflow.startedAt = workflow.startedAt || new Date().toISOString();
    workflow.updatedAt = new Date().toISOString();
    this._save(workflow);
    const chatId = workflow.metadata?.chatId || null;
    this.emit('workflow:started', { workflowId, chatId });

    try {
      await this._executeLoop(workflow, abortController.signal);
    } catch (error) {
      if (error.name === 'AbortError' || abortController.signal.aborted) {
        workflow.status = WORKFLOW_STATUS.PAUSED;
        this.emit('workflow:paused', { workflowId, chatId });
      } else {
        workflow.status = WORKFLOW_STATUS.FAILED;
        this.emit('workflow:failed', { workflowId, chatId, error: error.message });
      }
    } finally {
      this.activeExecutions.delete(workflowId);
      workflow.updatedAt = new Date().toISOString();
      this._save(workflow);
    }

    return workflow;
  }

  /**
   * Pause a running workflow.
   */
  pause(workflowId) {
    const controller = this.activeExecutions.get(workflowId);
    if (controller) {
      controller.abort();
    }
    const workflow = this.workflows.get(workflowId);
    if (workflow && workflow.status === WORKFLOW_STATUS.RUNNING) {
      workflow.status = WORKFLOW_STATUS.PAUSED;
      workflow.updatedAt = new Date().toISOString();
      this._save(workflow);
      this.emit('workflow:paused', { workflowId, chatId: workflow.metadata?.chatId || null });
    }
    return workflow;
  }

  /**
   * Cancel a workflow entirely.
   */
  cancel(workflowId) {
    const controller = this.activeExecutions.get(workflowId);
    if (controller) {
      controller.abort();
    }
    const workflow = this.workflows.get(workflowId);
    if (workflow) {
      workflow.status = WORKFLOW_STATUS.CANCELLED;
      workflow.updatedAt = new Date().toISOString();
      workflow.completedAt = new Date().toISOString();
      this._save(workflow);
      this.emit('workflow:cancelled', { workflowId, chatId: workflow.metadata?.chatId || null });
    }
    return workflow;
  }

  /**
   * Get workflow by ID.
   */
  get(workflowId) {
    return this.workflows.get(workflowId) || null;
  }

  /**
   * List all workflows, optionally filtered by status.
   */
  list(filter = {}) {
    let workflows = Array.from(this.workflows.values());
    if (filter.status) {
      workflows = workflows.filter((w) => w.status === filter.status);
    }
    return workflows.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  /**
   * Get progress summary for a workflow.
   */
  getProgress(workflowId) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    const total = workflow.tasks.length;
    const completed = workflow.tasks.filter((t) => t.status === TASK_STATUS.COMPLETED).length;
    const failed = workflow.tasks.filter((t) => t.status === TASK_STATUS.FAILED).length;
    const running = workflow.tasks.filter((t) => t.status === TASK_STATUS.RUNNING).length;
    const pending = workflow.tasks.filter((t) => t.status === TASK_STATUS.PENDING).length;

    return {
      workflowId,
      status: workflow.status,
      total,
      completed,
      failed,
      running,
      pending,
      percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
      goal: workflow.goal
    };
  }

  /**
   * Delete a workflow and its persisted state.
   */
  async delete(workflowId) {
    // Abort any running execution
    const controller = this.activeExecutions.get(workflowId);
    if (controller) {
      controller.abort();
      this.activeExecutions.delete(workflowId);
    }
    // Remove from memory first so any pending _save() becomes a no-op
    this.workflows.delete(workflowId);
    const filePath = path.join(this.storageDir, `${workflowId}.json`);
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // File may not exist
    }
    // Clean up any leftover tmp file
    try {
      await fs.promises.unlink(`${filePath}.tmp`);
    } catch {
      // Ignore
    }
  }

  // --- Internal execution ---

  async _executeLoop(workflow, signal) {
    while (true) {
      if (signal.aborted) {
        throw new DOMException('Workflow paused', 'AbortError');
      }

      const available = this._getAvailableTasks(workflow);
      if (available.length === 0) {
        // Check if all tasks are done
        const allDone = workflow.tasks.every(
          (t) => t.status === TASK_STATUS.COMPLETED || t.status === TASK_STATUS.FAILED || t.status === TASK_STATUS.SKIPPED
        );
        if (allDone) {
          workflow.status = WORKFLOW_STATUS.COMPLETED;
          workflow.completedAt = new Date().toISOString();
          this.emit('workflow:completed', { workflowId: workflow.id, chatId: workflow.metadata?.chatId || null });
        }
        break;
      }

      // Execute available tasks up to concurrency limit
      const batch = available.slice(0, this.maxConcurrentTasks);
      await Promise.all(batch.map((task) => this._executeTask(workflow, task, signal)));
      this._save(workflow);
    }
  }

  _getAvailableTasks(workflow) {
    return workflow.tasks
      .filter((task) => {
        if (task.status !== TASK_STATUS.PENDING) return false;
        // All dependencies must be completed
        return task.dependsOn.every((depId) => {
          const dep = workflow.tasks.find((t) => t.id === depId);
          return dep && (dep.status === TASK_STATUS.COMPLETED || dep.status === TASK_STATUS.SKIPPED);
        });
      })
      .sort((a, b) => a.priority - b.priority);
  }

  async _executeTask(workflow, task, signal) {
    if (signal.aborted) return;

    const agent = typeof this.getAgent === 'function' ? this.getAgent(task.agentId) : null;
    if (!agent) {
      task.status = TASK_STATUS.FAILED;
      task.error = `Agent "${task.agentId}" not found`;
      task.completedAt = new Date().toISOString();
      this.emit('workflow:task:failed', { workflowId: workflow.id, chatId: workflow.metadata?.chatId || null, taskId: task.id, title: task.title, error: task.error });
      return;
    }

    task.status = TASK_STATUS.RUNNING;
    task.startedAt = new Date().toISOString();
    workflow.updatedAt = new Date().toISOString();
    this.emit('workflow:task:started', { workflowId: workflow.id, chatId: workflow.metadata?.chatId || null, taskId: task.id, title: task.title });

    // Build context from completed dependency results
    const depContext = task.dependsOn
      .map((depId) => {
        const dep = workflow.tasks.find((t) => t.id === depId);
        if (dep && dep.result) {
          return `[Result from "${dep.title}"]: ${dep.result}`;
        }
        return null;
      })
      .filter(Boolean)
      .join('\n\n');

    const fullMessage = depContext
      ? `${task.description}\n\n--- Context from prior tasks ---\n${depContext}`
      : task.description;

    const executeOptions = {};
    if (workflow.metadata?.workingDirectory) {
      executeOptions.workingDirectory = workflow.metadata.workingDirectory;
    }
    if (task.preferredModel) {
      // Parse "provider:model" format
      const parts = task.preferredModel.split(':');
      if (parts.length === 2) {
        executeOptions.provider = parts[0];
        executeOptions.model = parts[1];
      } else {
        executeOptions.model = task.preferredModel;
      }
    }

    // Parent-chat context: pull the chat that launched this workflow and
    // semantically retrieve the slice relevant to this task. This gives each
    // task agent visibility into the user's surrounding conversation (e.g. a
    // pasted audit document) without replaying the whole transcript.
    const parentChatId = workflow.metadata?.chatId;
    if (parentChatId) {
      try {
        let parentMessages = this.getParentChatMessages(parentChatId) || [];
        parentMessages = parentMessages.filter((m) => m && (m.sender === 'user' || m.sender === 'assistant'));

        const compactor = this.getConversationCompactor();
        if (compactor && parentMessages.length > 0 && typeof compactor.shouldCompact === 'function' && compactor.shouldCompact(parentMessages)) {
          try {
            parentMessages = await compactor.retrieve(task.description || task.title || '', parentMessages, {
              maxChunks: 12,
              alwaysKeepRecent: 2,
              minSimilarity: 0.25,
              maxTokens: 2000
            });
          } catch (err) {
            console.warn(`[workflow-engine] Parent context compaction failed for task ${task.id}:`, err.message);
          }
        }

        const convertedParent = parentMessages
          .map((m) => ({
            role: m.sender === 'assistant' ? 'assistant' : 'user',
            content: typeof m.text === 'string' ? m.text : String(m.text || '')
          }))
          .filter((m) => m.content.trim().length > 0);

        if (convertedParent.length > 0) {
          executeOptions.messages = [
            ...convertedParent,
            { role: 'user', content: fullMessage }
          ];
        }
      } catch (err) {
        console.warn(`[workflow-engine] Failed to load parent chat context for task ${task.id}:`, err.message);
      }
    }

    try {
      const result = await this.agentExecutorAdapter.execute(agent, fullMessage, executeOptions);

      task.status = TASK_STATUS.COMPLETED;
      task.result = result.content || '';
      task.iterations = result.iterations || 0;
      task.llm = result.llm?.totals || null;
      task.completedAt = new Date().toISOString();

      this.emit('workflow:task:completed', {
        workflowId: workflow.id,
        chatId: workflow.metadata?.chatId || null,
        taskId: task.id,
        title: task.title
      });
    } catch (error) {
      task.status = TASK_STATUS.FAILED;
      task.error = error.message;
      task.completedAt = new Date().toISOString();

      this.emit('workflow:task:failed', {
        workflowId: workflow.id,
        chatId: workflow.metadata?.chatId || null,
        taskId: task.id,
        title: task.title,
        error: error.message
      });
    }
  }

  // --- Persistence ---

  async _save(workflow) {
    // Skip save if workflow has been deleted
    if (!this.workflows.has(workflow.id)) return;
    const filePath = path.join(this.storageDir, `${workflow.id}.json`);
    const tmpPath = `${filePath}.tmp`;
    try {
      await fs.promises.writeFile(tmpPath, JSON.stringify(workflow, null, 2), 'utf8');
      await fs.promises.rename(tmpPath, filePath);
    } catch (error) {
      console.error(`[workflow-engine] Failed to save workflow ${workflow.id}:`, error.message);
    }
  }

  async _loadAll() {
    try {
      const files = await fs.promises.readdir(this.storageDir);
      for (const file of files) {
        if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
        try {
          const raw = await fs.promises.readFile(path.join(this.storageDir, file), 'utf8');
          const workflow = JSON.parse(raw);
          if (workflow.id) {
            // Reset any tasks that were running when we last shut down
            for (const task of workflow.tasks || []) {
              if (task.status === TASK_STATUS.RUNNING) {
                task.status = TASK_STATUS.PENDING;
              }
            }
            if (workflow.status === WORKFLOW_STATUS.RUNNING) {
              workflow.status = WORKFLOW_STATUS.PAUSED;
            }
            this.workflows.set(workflow.id, workflow);
          }
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // Storage dir might not exist yet
    }
  }
}

module.exports = { WorkflowEngine, WORKFLOW_STATUS, TASK_STATUS };
