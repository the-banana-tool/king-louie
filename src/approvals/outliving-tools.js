// The tools that start or reach a run that outlives the turn calling them. A
// task's turn does not get them (src/tasks/values.js); a remote window's turn
// gets them only with the phone's yes (executor-options.js). One list, no
// requires: approvalSeam loads this on every profile.
const DETACHED_TOOLS = Object.freeze(['BackgroundTask', 'TaskStatus', 'Cron', 'RemoteDispatch']);
const TASK_REMOVED_TOOLS = Object.freeze(['message', ...DETACHED_TOOLS]);
const SESSION_TOOL_PREFIX = 'sessions_';
// A task keeps SpawnAgent, whose child ends with the task and is charged to it.
// A remote turn's child goes on after the window has gone.
const OUTLIVING = new Set([...TASK_REMOVED_TOOLS, 'SpawnAgent']);

function isSessionTool(name) {
  return typeof name === 'string' && name.startsWith(SESSION_TOOL_PREFIX);
}

function outlivesRemoteTurn(name) {
  return OUTLIVING.has(name) || isSessionTool(name);
}

module.exports = { DETACHED_TOOLS, TASK_REMOVED_TOOLS, isSessionTool, outlivesRemoteTurn };
