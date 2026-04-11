/**
 * Plan recovery — find a previously approved task graph in a chat's
 * message history.
 *
 * Cheap insurance against `workflows/{id}.json` corruption or accidental
 * deletion: every approved plan is also persisted as an assistant message
 * in the originating chat (see renderer.js `persistProposedPlan`). If the
 * workflow file is gone, we can still rebuild from chat history.
 *
 * Recovery only works for plans persisted with the structured-metadata
 * format (`workflowScaffolding: { kind, taskGraph }`). Older messages with
 * `workflowScaffolding: true` carry only the markdown rendering and are
 * not recoverable — they're listed in `legacyCount` so the caller can warn.
 */

const { validateTaskGraph, TaskGraphValidationError } = require('./task-graph-validator');

/**
 * Scan a messages array (newest-last) and return the most recent recoverable
 * task graph. Walks backwards and returns on the first valid embedded graph,
 * counting any legacy `workflowScaffolding: true` messages along the way.
 *
 * Returns:
 *   { taskGraph, kind, messageId, legacyCount } on success
 *   { taskGraph: null, legacyCount } when nothing recoverable
 */
function recoverPlanFromMessages(messages) {
  if (!Array.isArray(messages)) {
    return { taskGraph: null, legacyCount: 0 };
  }

  let legacyCount = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || !msg.workflowScaffolding) continue;

    if (msg.workflowScaffolding === true) {
      legacyCount++;
      continue;
    }

    if (typeof msg.workflowScaffolding !== 'object') continue;
    const { taskGraph, kind } = msg.workflowScaffolding;
    if (!taskGraph || !Array.isArray(taskGraph.tasks)) continue;

    try {
      validateTaskGraph(taskGraph);
    } catch (err) {
      if (!(err instanceof TaskGraphValidationError)) throw err;
      continue;
    }

    return {
      taskGraph,
      kind: kind || 'proposed',
      messageId: msg.id || null,
      legacyCount
    };
  }

  return { taskGraph: null, legacyCount };
}

module.exports = { recoverPlanFromMessages };
