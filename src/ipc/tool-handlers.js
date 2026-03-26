const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function registerToolHandlers(ipcMain, context = {}) {
  const {
    toolRegistry,
    createToolExecutorWithApprovals,
    pendingApprovalResolvers,
    pendingDirectoryAccessResolvers,
    setToolAlwaysApprove
  } = context;

  ipcMain.handle(IPC.TOOL_EXECUTE, wrapHandler(IPC.TOOL_EXECUTE, async (event, { toolName, parameters }) => {
    const executor = await createToolExecutorWithApprovals(event);
    return executor.execute(toolName, parameters);
  }));

  ipcMain.handle(IPC.TOOL_LIST, wrapHandler(IPC.TOOL_LIST, async () => {
    return toolRegistry.getFunctionDefinitions();
  }));

  ipcMain.on(IPC.TOOL_APPROVAL_RESPONSE, (_event, { approvalId, approved, alwaysApprove }) => {
    const pendingApproval = pendingApprovalResolvers.get(approvalId);
    if (!pendingApproval) return;

    pendingApprovalResolvers.delete(approvalId);

    if (Boolean(approved) && Boolean(alwaysApprove) && pendingApproval.toolName) {
      setToolAlwaysApprove(pendingApproval.toolName, true);
    }

    pendingApproval.resolve(Boolean(approved));
  });

  ipcMain.on(IPC.TOOL_DIRECTORY_ACCESS_RESPONSE, (_event, { requestId, approved }) => {
    if (!pendingDirectoryAccessResolvers) return;
    const pending = pendingDirectoryAccessResolvers.get(requestId);
    if (!pending) return;

    pendingDirectoryAccessResolvers.delete(requestId);
    pending.resolve(Boolean(approved));
  });
}

module.exports = {
  registerToolHandlers
};