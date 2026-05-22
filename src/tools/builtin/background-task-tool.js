const { Tool } = require('../tool-schema');
const { createWorktree } = require('../../execution/worktree');

/**
 * BackgroundTask tool — spawns an agent task that runs independently
 * in the background. The main conversation continues immediately while
 * the background task executes.
 *
 * Use TaskStatus to check progress and read output.
 *
 * Example use cases:
 *  - "Run the test suite in the background while I continue"
 *  - "Search the codebase for all TODO comments in the background"
 *  - "Build the project in the background"
 */
// Tools whose presence in a task instruction signals the task needs the
// approval bridge. If the parent context can't supply one, we reject upfront
// instead of letting the bg agent silently auto-deny every gated call.
const GATED_TOOL_HINTS = [
  'browser', 'vault', 'bash', 'edit ', 'edit_file', 'write ', 'write_file',
  'git ', 'multiedit', 'multi_edit', 'skill ', 'cron', 'remote'
];

const BackgroundTaskTool = new Tool({
  name: 'BackgroundTask',
  description:
    'Spawn a task that runs in the background while you continue the conversation. ' +
    'The task runs an agent independently and stores its output for later review. ' +
    'Use TaskStatus to check progress, read output, or stop background tasks. ' +
    'NOTE: the bg agent gets its own tool runtime — it CAN call gated tools ' +
    '(Browser, Vault, Bash, Edit, Write, Git) and approval prompts will surface ' +
    'in this same chat, but it does NOT share the foreground browser instance. ' +
    'For long-running browser sessions, prefer to drive them inline rather than ' +
    'handing them to a bg task.',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The instruction/task for the background agent to execute'
      },
      agentId: {
        type: 'string',
        description: 'Which agent to use: "main", "code-explorer", "code-writer". Defaults to "main".'
      },
      description: {
        type: 'string',
        description: 'Short description of the background task (shown in task list)'
      },
      isolate: {
        type: 'boolean',
        description: 'Run in an isolated git worktree to prevent file conflicts with the main workspace (default: false)'
      }
    },
    required: ['task']
  },
  requiresApproval: false,
  execute: async (params, options = {}) => {
    const {
      backgroundTaskManager,
      agentExecutorAdapter,
      getAgent,
      approvalRequester
    } = options;

    if (!backgroundTaskManager) {
      return { ok: false, error: 'Background task manager not available.' };
    }
    if (!agentExecutorAdapter) {
      return { ok: false, error: 'Agent executor not available.' };
    }
    if (typeof getAgent !== 'function') {
      return { ok: false, error: 'Agent resolver not available.' };
    }

    // Upfront reject: if the task references gated tools but we have no way to
    // surface approvals back to a user, every such call would silently auto-deny.
    if (typeof approvalRequester !== 'function') {
      const lower = String(params.task || '').toLowerCase();
      const matched = GATED_TOOL_HINTS.find((t) => lower.includes(t));
      if (matched) {
        return {
          ok: false,
          error:
            `Refusing to spawn: this task mentions "${matched.trim()}" which requires user approval, ` +
            `but no approval channel is wired into the parent context (no chat UI to prompt). ` +
            `Either run the work in the foreground, or pre-approve the relevant tool globally.`
        };
      }
    }

    const agentId = params.agentId || 'main';
    const agent = getAgent(agentId);
    if (!agent) {
      return { ok: false, error: `Unknown agent: ${agentId}` };
    }

    const useIsolation = params.isolate === true;
    const workingDirectory = options.workingDirectory || process.cwd();

    try {
      const task = await backgroundTaskManager.spawn(
        {
          description: params.description || params.task.substring(0, 100),
          agentId
        },
        async (bgTask) => {
          let worktreeInfo = null;
          let taskWorkDir = workingDirectory;

          // Create isolated worktree if requested
          if (useIsolation) {
            try {
              worktreeInfo = await createWorktree(workingDirectory, bgTask.id);
              taskWorkDir = worktreeInfo.worktreePath;
              backgroundTaskManager.appendOutput(bgTask.id,
                `[${new Date().toISOString()}] Worktree created: ${worktreeInfo.branch} at ${taskWorkDir}`);
            } catch (err) {
              backgroundTaskManager.appendOutput(bgTask.id,
                `[${new Date().toISOString()}] Worktree creation failed (running in main workspace): ${err.message}`);
            }
          }

          backgroundTaskManager.appendOutput(bgTask.id,
            `[${new Date().toISOString()}] Starting: ${params.task}`);

          try {
            const result = await agentExecutorAdapter.execute(
              agent,
              params.task,
              {
                maxIterations: 20,
                abortSignal: bgTask.signal,
                workingDirectory: taskWorkDir,
                // Bridge approvals back to whoever spawned us (typically the
                // foreground chat UI). Without this, the bg agent's gated tool
                // calls would silently auto-deny.
                approvalRequester
              }
            );

            backgroundTaskManager.appendOutput(bgTask.id,
              `[${new Date().toISOString()}] Result: ${result.content?.substring(0, 500) || '(no content)'}`);

            return result;
          } finally {
            // Clean up worktree
            if (worktreeInfo) {
              try {
                const cleanResult = await worktreeInfo.cleanup();
                if (cleanResult.hasChanges) {
                  backgroundTaskManager.appendOutput(bgTask.id,
                    `[${new Date().toISOString()}] Worktree has changes on branch: ${cleanResult.branch}`);
                } else {
                  backgroundTaskManager.appendOutput(bgTask.id,
                    `[${new Date().toISOString()}] Worktree cleaned up (no changes)`);
                }
              } catch (err) {
                backgroundTaskManager.appendOutput(bgTask.id,
                  `[${new Date().toISOString()}] Worktree cleanup failed: ${err.message}`);
              }
            }
          }
        }
      );

      return {
        ok: true,
        taskId: task.id,
        message: `Background task started: ${task.id}. Use TaskStatus to check progress.`
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
});

/**
 * TaskStatus tool — check status, read output, list, or stop background tasks.
 */
const TaskStatusTool = new Tool({
  name: 'TaskStatus',
  description:
    'Check the status of background tasks, read their output, list all tasks, or stop a running task.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'output', 'list', 'stop'],
        description: 'Action to perform. "status" checks a specific task, "output" reads its full output, "list" shows all tasks, "stop" cancels a running task.'
      },
      taskId: {
        type: 'string',
        description: 'The background task ID (required for status, output, stop actions)'
      }
    },
    required: ['action']
  },
  concurrencySafe: true,
  execute: async (params, options = {}) => {
    const { backgroundTaskManager } = options;
    if (!backgroundTaskManager) {
      return { ok: false, error: 'Background task manager not available.' };
    }

    const { action, taskId } = params;

    if (action === 'list') {
      const tasks = backgroundTaskManager.list();
      return {
        ok: true,
        tasks,
        message: tasks.length > 0
          ? `${tasks.length} background task(s)`
          : 'No background tasks.'
      };
    }

    if (!taskId) {
      return { ok: false, error: `taskId is required for action "${action}"` };
    }

    if (action === 'status') {
      const task = backgroundTaskManager.get(taskId);
      if (!task) return { ok: false, error: `Task not found: ${taskId}` };
      return {
        ok: true,
        id: task.id,
        state: task.state,
        description: task.description,
        agentId: task.agentId,
        startedAt: task.startedAt ? new Date(task.startedAt).toISOString() : null,
        completedAt: task.completedAt ? new Date(task.completedAt).toISOString() : null,
        error: task.error,
        result: task.result?.content?.substring(0, 1000) || null
      };
    }

    if (action === 'output') {
      const output = backgroundTaskManager.readOutput(taskId);
      if (output === null) return { ok: false, error: `No output available for task ${taskId}` };
      return { ok: true, output };
    }

    if (action === 'stop') {
      try {
        backgroundTaskManager.stop(taskId);
        return { ok: true, message: `Task ${taskId} stopped.` };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    return { ok: false, error: `Unknown action: ${action}` };
  }
});

module.exports = { BackgroundTaskTool, TaskStatusTool };
