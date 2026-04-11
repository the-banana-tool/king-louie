/**
 * Task graph validation — used by the planner (on raw planner output) AND
 * by the IPC layer (on user-edited graphs before workflow:create).
 *
 * Validation enforces:
 *   - tasks array non-empty
 *   - every task has an id and a description
 *   - dependsOn references resolve to known task ids (orphans rejected, not silently dropped)
 *   - no self-loops
 *   - no cycles in the dependency graph
 *   - every task is reachable from at least one root (no orphan subgraphs)
 *
 * Throws TaskGraphValidationError on failure. The error carries a `code`
 * and `details` so the UI can render targeted feedback.
 */

class TaskGraphValidationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'TaskGraphValidationError';
    this.code = code;
    this.details = details;
  }
}

function validateTaskGraph(taskGraph) {
  if (!taskGraph || typeof taskGraph !== 'object') {
    throw new TaskGraphValidationError('Task graph must be an object', 'NOT_OBJECT');
  }

  if (!Array.isArray(taskGraph.tasks) || taskGraph.tasks.length === 0) {
    throw new TaskGraphValidationError('Task graph has no tasks', 'EMPTY');
  }

  const taskIds = new Set();
  for (const task of taskGraph.tasks) {
    if (!task || typeof task !== 'object') {
      throw new TaskGraphValidationError('Task entry is not an object', 'BAD_TASK');
    }
    if (!task.id || typeof task.id !== 'string') {
      throw new TaskGraphValidationError('Task is missing an id', 'MISSING_ID', { task });
    }
    if (taskIds.has(task.id)) {
      throw new TaskGraphValidationError(`Duplicate task id: ${task.id}`, 'DUPLICATE_ID', { taskId: task.id });
    }
    taskIds.add(task.id);
    if (!task.description && !task.title) {
      throw new TaskGraphValidationError(`Task ${task.id} has no description or title`, 'MISSING_DESCRIPTION', { taskId: task.id });
    }
  }

  for (const task of taskGraph.tasks) {
    const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    for (const depId of deps) {
      if (depId === task.id) {
        throw new TaskGraphValidationError(
          `Task ${task.id} depends on itself`,
          'SELF_LOOP',
          { taskId: task.id }
        );
      }
      if (!taskIds.has(depId)) {
        throw new TaskGraphValidationError(
          `Task ${task.id} depends on unknown task ${depId}`,
          'ORPHAN_DEPENDENCY',
          { taskId: task.id, missingDep: depId }
        );
      }
    }
  }

  const cyclePath = findCycle(taskGraph.tasks);
  if (cyclePath) {
    throw new TaskGraphValidationError(
      `Task graph has a circular dependency: ${cyclePath.join(' -> ')}`,
      'CYCLE',
      { cycle: cyclePath }
    );
  }

  return true;
}

function findCycle(tasks) {
  const adjacency = new Map();
  for (const task of tasks) {
    adjacency.set(task.id, Array.isArray(task.dependsOn) ? task.dependsOn : []);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const id of adjacency.keys()) color.set(id, WHITE);

  const stack = [];

  const visit = (nodeId) => {
    color.set(nodeId, GRAY);
    stack.push(nodeId);
    for (const dep of adjacency.get(nodeId) || []) {
      if (color.get(dep) === GRAY) {
        const cycleStart = stack.indexOf(dep);
        return stack.slice(cycleStart).concat(dep);
      }
      if (color.get(dep) === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(nodeId, BLACK);
    return null;
  };

  for (const id of adjacency.keys()) {
    if (color.get(id) === WHITE) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

module.exports = {
  validateTaskGraph,
  TaskGraphValidationError
};
