const { wrapHandler } = require('./wrap-handler');
const constants = require('./constants');

function registerWorkflowHandlers(ipcMain, context) {
  ipcMain.handle(
    constants.WORKFLOW_PLAN,
    wrapHandler('workflow:plan', async (event, payload) => {
      const planner = context.getPlannerExecutor();
      if (!planner) throw new Error('Planner not available');
      const taskGraph = await planner.plan(payload.goal, payload.options || {});
      return { ok: true, taskGraph };
    })
  );

  ipcMain.handle(
    constants.WORKFLOW_PLAN_AND_EXECUTE,
    wrapHandler('workflow:planAndExecute', async (event, payload) => {
      const planner = context.getPlannerExecutor();
      if (!planner) throw new Error('Planner not available');
      const workflow = await planner.planAndExecute(payload.goal, {
        ...(payload.options || {}),
        background: payload.background !== false
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
}

module.exports = {
  registerWorkflowHandlers
};
