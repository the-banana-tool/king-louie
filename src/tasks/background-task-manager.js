const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const log = createLogger('background-task');

/**
 * BackgroundTaskManager — manages agent tasks that run independently
 * in the background while the main conversation continues.
 *
 * Each background task:
 *  - Runs in its own agent loop (separate conversation context)
 *  - Streams output to a file on disk for later review
 *  - Can be checked for status, read output, or stopped
 *  - Reports completion/failure via events
 *
 * This enables patterns like "run tests while I continue coding" or
 * "search the codebase in the background".
 */

const TASK_STATES = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPED: 'stopped'
};

class BackgroundTask {
  constructor(config = {}) {
    this.id = config.id || `bg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    this.description = config.description || '';
    this.agentId = config.agentId || 'main';
    this.state = TASK_STATES.PENDING;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.outputFile = config.outputFile || null;
    this.result = null;
    this.error = null;
    this._abortController = new AbortController();
  }

  get signal() {
    return this._abortController.signal;
  }

  stop() {
    this._abortController.abort();
    if (this.state === TASK_STATES.RUNNING) {
      this.state = TASK_STATES.STOPPED;
      this.completedAt = Date.now();
    }
  }
}

class BackgroundTaskManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.outputDir - directory for task output files
   * @param {number} [options.maxConcurrent=5] - max concurrent background tasks
   */
  constructor(options = {}) {
    super();
    this._tasks = new Map(); // taskId → BackgroundTask
    this._outputDir = options.outputDir || null;
    this._maxConcurrent = options.maxConcurrent || 5;
  }

  /**
   * Create and start a background task.
   * @param {object} config - task configuration
   * @param {string} config.description - what the task should do
   * @param {string} [config.agentId] - agent to use
   * @param {Function} executor - async function(task) that runs the agent
   * @returns {BackgroundTask}
   */
  async spawn(config, executor) {
    const running = Array.from(this._tasks.values())
      .filter(t => t.state === TASK_STATES.RUNNING);
    if (running.length >= this._maxConcurrent) {
      throw new Error(`Maximum concurrent background tasks reached (${this._maxConcurrent})`);
    }

    // Create output file
    let outputFile = null;
    if (this._outputDir) {
      try {
        fs.mkdirSync(this._outputDir, { recursive: true });
        outputFile = path.join(this._outputDir, `${config.id || `bg-${Date.now()}`}.log`);
      } catch {
        // Non-fatal: output just won't be persisted
      }
    }

    const task = new BackgroundTask({ ...config, outputFile });
    this._tasks.set(task.id, task);
    this.emit('taskCreated', task);

    // Run asynchronously — don't await
    this._runTask(task, executor).catch((err) => {
      log.error(`Task ${task.id} crashed: ${err.message}`);
    });

    return task;
  }

  async _runTask(task, executor) {
    task.state = TASK_STATES.RUNNING;
    task.startedAt = Date.now();
    this.emit('taskStarted', task);

    try {
      const result = await executor(task);

      if (task.signal.aborted) {
        task.state = TASK_STATES.STOPPED;
      } else {
        task.state = TASK_STATES.COMPLETED;
        task.result = result;
      }
    } catch (err) {
      if (task.signal.aborted) {
        task.state = TASK_STATES.STOPPED;
      } else {
        task.state = TASK_STATES.FAILED;
        task.error = err.message;
      }
    }

    task.completedAt = Date.now();

    // Write final result to output file
    if (task.outputFile) {
      try {
        const summary = JSON.stringify({
          id: task.id,
          state: task.state,
          description: task.description,
          duration: task.completedAt - task.startedAt,
          result: task.result?.content || task.result,
          error: task.error
        }, null, 2);
        fs.appendFileSync(task.outputFile, `\n--- TASK COMPLETE (${task.state}) ---\n${summary}\n`);
      } catch {
        // Non-fatal
      }
    }

    this.emit('taskCompleted', task);
  }

  /**
   * Get a task by ID.
   */
  get(taskId) {
    return this._tasks.get(taskId);
  }

  /**
   * List all background tasks.
   */
  list() {
    return Array.from(this._tasks.values()).map(t => ({
      id: t.id,
      description: t.description,
      state: t.state,
      agentId: t.agentId,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      completedAt: t.completedAt,
      hasOutput: !!t.outputFile,
      error: t.error
    }));
  }

  /**
   * Stop a background task.
   */
  stop(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`Background task not found: ${taskId}`);
    task.stop();
    return task;
  }

  /**
   * Read the output of a completed or running task.
   */
  readOutput(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) throw new Error(`Background task not found: ${taskId}`);
    if (!task.outputFile) return null;

    try {
      return fs.readFileSync(task.outputFile, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Append output to a task's log file.
   */
  appendOutput(taskId, text) {
    const task = this._tasks.get(taskId);
    if (!task?.outputFile) return;
    try {
      fs.appendFileSync(task.outputFile, text + '\n');
    } catch {
      // Non-fatal
    }
  }

  /**
   * Clean up completed/stopped tasks older than maxAge ms.
   */
  cleanup(maxAgeMs = 30 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [id, task] of this._tasks) {
      if (task.completedAt && task.completedAt < cutoff) {
        this._tasks.delete(id);
      }
    }
  }
}

module.exports = { BackgroundTask, BackgroundTaskManager, TASK_STATES };
