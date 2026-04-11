const { wrapHandler } = require('./wrap-handler');
const constants = require('./constants');
const { validateTaskGraph, TaskGraphValidationError } = require('../workflows/task-graph-validator');
const { recoverPlanFromMessages } = require('../workflows/plan-recovery');

function registerWorkflowHandlers(ipcMain, context) {
  const mergePlanOptions = (payload) => {
    const options = { ...(payload.options || {}) };
    if (payload.chatId) options.chatId = payload.chatId;
    if (payload.workingDirectory) options.workingDirectory = payload.workingDirectory;
    if (Array.isArray(payload.chatMessages)) options.chatMessages = payload.chatMessages;
    return options;
  };

  ipcMain.handle(
    constants.WORKFLOW_PLAN,
    wrapHandler('workflow:plan', async (event, payload) => {
      const planner = context.getPlannerExecutor();
      if (!planner) throw new Error('Planner not available');
      try {
        const taskGraph = await planner.plan(payload.goal, mergePlanOptions(payload));
        return { ok: true, taskGraph };
      } catch (err) {
        // Preserve planner raw output so the UI can show the user what the
        // planner actually said (clarifying question, refusal, malformed JSON).
        return {
          ok: false,
          error: err.message || String(err),
          plannerOutput: typeof err.plannerOutput === 'string' ? err.plannerOutput : null
        };
      }
    })
  );

  ipcMain.handle(
    constants.WORKFLOW_PLAN_AND_EXECUTE,
    wrapHandler('workflow:planAndExecute', async (event, payload) => {
      const planner = context.getPlannerExecutor();
      if (!planner) throw new Error('Planner not available');
      const options = {
        ...mergePlanOptions(payload),
        background: payload.background !== false
      };
      const workflow = await planner.planAndExecute(payload.goal, options);
      return { ok: true, workflow };
    })
  );

  ipcMain.handle(
    constants.WORKFLOW_CREATE,
    wrapHandler('workflow:create', async (event, payload) => {
      const engine = context.getWorkflowEngine();
      if (!engine) throw new Error('Workflow engine not available');
      if (!payload?.taskGraph) throw new Error('taskGraph is required');

      // Re-validate: the task graph may have been edited in the approval UI
      // since the planner produced it. Catch self-loops, cycles, orphan
      // dependencies, and missing fields BEFORE persisting the workflow.
      try {
        validateTaskGraph(payload.taskGraph);
      } catch (err) {
        if (err instanceof TaskGraphValidationError) {
          return {
            ok: false,
            error: err.message,
            validationCode: err.code,
            validationDetails: err.details || null
          };
        }
        throw err;
      }

      // Capture the user's mode/permission state at the moment of approval.
      // The workflow runs against this snapshot, not against whatever the
      // user toggles to mid-flight.
      let modeSnapshot = null;
      const getChats = typeof context.getChats === 'function' ? context.getChats : null;
      const store = typeof context.getStore === 'function' ? context.getStore() : null;
      if (payload.chatId && getChats) {
        const chat = getChats().find((c) => c && c.id === payload.chatId);
        if (chat) {
          const settings = store ? store.get('settings', {}) : {};
          modeSnapshot = {
            agentMode: chat.agentMode === true,
            sandboxMode: chat.sandboxMode !== false,
            allowedDirectories: Array.isArray(settings.allowedDirectories)
              ? [...settings.allowedDirectories]
              : [],
            capturedAt: new Date().toISOString()
          };
        }
      }

      const workflow = await engine.create(payload.taskGraph, {
        chatId: payload.chatId || null,
        workingDirectory: payload.workingDirectory || null,
        modeSnapshot
      });
      return { ok: true, workflow };
    })
  );

  ipcMain.handle(
    constants.WORKFLOW_RUN,
    wrapHandler('workflow:run', async (event, payload) => {
      const engine = context.getWorkflowEngine();
      if (!engine) throw new Error('Workflow engine not available');
      // Run in background by default
      engine.run(payload.id).catch((err) => {
        console.error(`[workflow-handlers] Workflow ${payload.id} failed:`, err.message);
      });
      return { ok: true, id: payload.id };
    })
  );

  ipcMain.handle(
    constants.WORKFLOW_PAUSE,
    wrapHandler('workflow:pause', async (event, payload) => {
      const engine = context.getWorkflowEngine();
      if (!engine) throw new Error('Workflow engine not available');
      const workflow = engine.pause(payload.id);
      return { ok: true, workflow };
    })
  );

  ipcMain.handle(
    constants.WORKFLOW_CANCEL,
    wrapHandler('workflow:cancel', async (event, payload) => {
      const engine = context.getWorkflowEngine();
      if (!engine) throw new Error('Workflow engine not available');
      const workflow = engine.cancel(payload.id);
      return { ok: true, workflow };
    })
  );

  ipcMain.handle(
    constants.WORKFLOW_LIST,
    wrapHandler('workflow:list', async (event, payload) => {
      const engine = context.getWorkflowEngine();
      if (!engine) throw new Error('Workflow engine not available');
      const workflows = engine.list(payload || {});
      return { ok: true, workflows };
    })
  );

  ipcMain.handle(
    constants.WORKFLOW_GET,
    wrapHandler('workflow:get', async (event, payload) => {
      const engine = context.getWorkflowEngine();
      if (!engine) throw new Error('Workflow engine not available');
      const workflow = engine.get(payload.id);
      return { ok: true, workflow };
    })
  );

  ipcMain.handle(
    constants.WORKFLOW_PROGRESS,
    wrapHandler('workflow:progress', async (event, payload) => {
      const engine = context.getWorkflowEngine();
      if (!engine) throw new Error('Workflow engine not available');
      const progress = engine.getProgress(payload.id);
      return { ok: true, progress };
    })
  );

  ipcMain.handle(
    constants.WORKFLOW_DELETE,
    wrapHandler('workflow:delete', async (event, payload) => {
      const engine = context.getWorkflowEngine();
      if (!engine) throw new Error('Workflow engine not available');
      await engine.delete(payload.id);
      return { ok: true };
    })
  );

  ipcMain.handle(
    constants.WORKFLOW_RECOVER_PLAN,
    wrapHandler('workflow:recoverPlan', async (event, payload = {}) => {
      const chatId = payload.chatId;
      if (!chatId) throw new Error('chatId is required');
      const getChats = typeof context.getChats === 'function' ? context.getChats : null;
      if (!getChats) throw new Error('Chat storage not available');
      const chat = getChats().find((c) => c && c.id === chatId);
      if (!chat) return { ok: false, error: 'Chat not found' };
      const recovered = recoverPlanFromMessages(chat.messages || []);
      if (!recovered.taskGraph) {
        return { ok: false, error: 'No recoverable plan in chat history', legacyCount: recovered.legacyCount };
      }
      return {
        ok: true,
        taskGraph: recovered.taskGraph,
        kind: recovered.kind,
        messageId: recovered.messageId,
        legacyCount: recovered.legacyCount
      };
    })
  );
}

module.exports = {
  registerWorkflowHandlers
};
