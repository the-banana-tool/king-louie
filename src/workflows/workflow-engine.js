const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const AsyncMutex = require('./async-mutex');

// Cap a single dependency-result block at this many characters when handing
// it down to a downstream task. Oversized results get head/tail clipped with
// a marker; the full result is still saved on the task object for the UI.
const DEP_RESULT_HEAD = 1500;
const DEP_RESULT_TAIL = 500;

function summarizeResult(text) {
  const raw = typeof text === 'string' ? text : String(text || '');
  if (raw.length <= DEP_RESULT_HEAD + DEP_RESULT_TAIL + 64) {
    return { summary: raw, truncated: false };
  }
  const head = raw.slice(0, DEP_RESULT_HEAD);
  const tail = raw.slice(-DEP_RESULT_TAIL);
  const dropped = raw.length - DEP_RESULT_HEAD - DEP_RESULT_TAIL;
  const summary = `${head}\n\n... [${dropped} chars elided] ...\n\n${tail}`;
  return { summary, truncated: true };
}

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
    // Per-task wall-clock timeout. Tasks that exceed it are marked failed so
    // their dependents can either skip or run; the underlying agent loop may
    // still be running in the background, but the workflow no longer waits
    // on it. Override per-task via task.timeoutMs.
    this.defaultTaskTimeoutMs = Number.isFinite(options.defaultTaskTimeoutMs)
      ? options.defaultTaskTimeoutMs
      : 10 * 60 * 1000;
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
    // Per-workflow mutex serializes _save (writeFile + rename) and prevents
    // pause/cancel from racing _executeLoop's state mutations.
    this._saveMutex = new AsyncMutex();
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
        timeoutMs: Number.isFinite(t.timeoutMs) ? t.timeoutMs : null,
        result: null,
        resultSummary: null,
        resultTruncated: false,
        error: null,
        startedAt: null,
        completedAt: null,
        iterations: 0,
        llm: null
      })),
      parallelGroups: taskGraph.parallelGroups || [],
      // High-water-mark counter for task IDs. Mint via mintTaskId() so even
      // after a task is deleted in the approval UI, its id can never be
      // reused — stale references in chat history stay unambiguous.
      nextTaskIdCounter: taskGraph.tasks.length,
      metadata: {
        estimatedTotalSteps: taskGraph.estimatedTotalSteps || taskGraph.tasks.length,
        requiresUserInput: taskGraph.requiresUserInput || false,
        userInputNeeded: taskGraph.userInputNeeded || null,
        chatId: opts.chatId || null,
        workingDirectory: opts.workingDirectory || null,
        // User-approved action categories (e.g. "run-tests", "install-deps").
        // Today this is metadata + system-prompt hint only — real per-tool
        // gating would require mapping categories to tools in ToolExecutor.
        allowedActions: Array.isArray(taskGraph.allowedActions) ? taskGraph.allowedActions : [],
        // Mode snapshot at approval time. Captures the user's intent at the
        // moment they approved the plan, so a later toggle of agentMode or
        // sandboxMode doesn't silently change the workflow's permission
        // posture mid-flight. Audit trail today; enforcement is wired in
        // wherever the executor consumes these fields.
        modeSnapshot: opts.modeSnapshot || null
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
   * Mint a new task id for a workflow that monotonically increases. Even
   * after a task is deleted in the approval UI, its id is never reused.
   * Persists the bump synchronously into the workflow object; the next
   * _save() will write it to disk.
   */
  mintTaskId(workflowId) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
    if (typeof workflow.nextTaskIdCounter !== 'number') {
      workflow.nextTaskIdCounter = (workflow.tasks || []).length;
    }
    const n = workflow.nextTaskIdCounter;
    workflow.nextTaskIdCounter = n + 1;
    return `task-${n + 1}`;
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

    // Structured dependency context: each upstream result is wrapped in a
    // labeled block with a head/tail-clipped summary so a 100KB result from
    // one task can't blow out the next task's context window. The summary
    // is computed once and cached on the upstream task object.
    const depBlocks = [];
    for (const depId of task.dependsOn) {
      const dep = workflow.tasks.find((t) => t.id === depId);
      if (!dep || !dep.result) continue;
      if (!dep.resultSummary) {
        const { summary, truncated } = summarizeResult(dep.result);
        dep.resultSummary = summary;
        dep.resultTruncated = truncated;
      }
      const truncationNote = dep.resultTruncated
        ? ' (truncated — full result available in workflow record)'
        : '';
      depBlocks.push(
        `### Result from upstream task: ${dep.title || dep.id} [${dep.id}]${truncationNote}\n${dep.resultSummary}`
      );
    }

    const allowedActions = Array.isArray(workflow.metadata?.allowedActions)
      ? workflow.metadata.allowedActions
      : [];
    const allowedActionsBlock = allowedActions.length
      ? `\n\n--- Pre-approved actions for this workflow ---\nThe user approved this plan with explicit permission to: ${allowedActions.join(', ')}.`
      : '';

    const fullMessage = depBlocks.length
      ? `${task.description}\n\n--- Context from prior tasks ---\n\n${depBlocks.join('\n\n')}${allowedActionsBlock}`
      : `${task.description}${allowedActionsBlock}`;

    const executeOptions = {};
    if (workflow.metadata?.workingDirectory) {
      executeOptions.workingDirectory = workflow.metadata.workingDirectory;
    }
    // Apply the mode snapshot captured at approval time. This ensures a
    // user toggling sandboxMode or allowedDirectories mid-flight doesn't
    // silently change the workflow's permission posture.
    const snapshot = workflow.metadata?.modeSnapshot;
    if (snapshot) {
      if (typeof snapshot.sandboxMode === 'boolean') {
        executeOptions.useSandbox = snapshot.sandboxMode;
      }
      if (Array.isArray(snapshot.allowedDirectories) && snapshot.allowedDirectories.length > 0) {
        executeOptions.allowedDirectories = snapshot.allowedDirectories;
      }
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

    const timeoutMs = Number.isFinite(task.timeoutMs) && task.timeoutMs > 0
      ? task.timeoutMs
      : this.defaultTaskTimeoutMs;

    let timeoutHandle = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const err = new Error(`Task timed out after ${Math.round(timeoutMs / 1000)}s`);
        err.code = 'TASK_TIMEOUT';
        reject(err);
      }, timeoutMs);
      if (timeoutHandle && typeof timeoutHandle.unref === 'function') {
        timeoutHandle.unref();
      }
    });

    try {
      const result = await Promise.race([
        this.agentExecutorAdapter.execute(agent, fullMessage, executeOptions),
        timeoutPromise
      ]);

      task.status = TASK_STATUS.COMPLETED;
      task.result = result.content || '';
      const { summary, truncated } = summarizeResult(task.result);
      task.resultSummary = summary;
      task.resultTruncated = truncated;
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
      if (error.code === 'TASK_TIMEOUT') {
        task.timedOut = true;
      }

      this.emit('workflow:task:failed', {
        workflowId: workflow.id,
        chatId: workflow.metadata?.chatId || null,
        taskId: task.id,
        title: task.title,
        error: error.message,
        timedOut: error.code === 'TASK_TIMEOUT'
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  // --- Persistence ---

  async _save(workflow) {
    // Serialize per-workflow: a concurrent _save would race writeFile/rename
    // and could leave a stale .tmp or a half-written .json on disk.
    return this._saveMutex.run(workflow.id, async () => {
      // Skip save if workflow has been deleted while we were queued.
      if (!this.workflows.has(workflow.id)) return;
      const filePath = path.join(this.storageDir, `${workflow.id}.json`);
      const tmpPath = `${filePath}.tmp`;
      try {
        // Snapshot inside the critical section so a mutation between waiters
        // doesn't bleed into the previous write's serialized payload.
        const payload = JSON.stringify(workflow, null, 2);
        await fs.promises.writeFile(tmpPath, payload, 'utf8');
        await fs.promises.rename(tmpPath, filePath);
      } catch (error) {
        console.error(`[workflow-engine] Failed to save workflow ${workflow.id}:`, error.message);
      }
    });
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
