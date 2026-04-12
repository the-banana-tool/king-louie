const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

function registerToolHandlers(ipcMain, context = {}) {
  const {
    toolRegistry,
    createToolExecutorWithApprovals,
    pendingApprovalResolvers,
    pendingDirectoryAccessResolvers,
    setToolAlwaysApprove,
    addPermissionRule,
    getPermissionRules,
    removePermissionRule
  } = context;

  ipcMain.handle(IPC.TOOL_EXECUTE, wrapHandler(IPC.TOOL_EXECUTE, async (event, { toolName, parameters }) => {
    const executor = await createToolExecutorWithApprovals(event);
    return executor.execute(toolName, parameters);
  }));

  ipcMain.handle(IPC.TOOL_LIST, wrapHandler(IPC.TOOL_LIST, async () => {
    return toolRegistry.getFunctionDefinitions();
  }));

  ipcMain.on(IPC.TOOL_APPROVAL_RESPONSE, (_event, payload = {}) => {
    const { approvalId, approved, alwaysApprove, alwaysAllowPattern, rulePattern, ruleAction } = payload;
    const pendingApproval = pendingApprovalResolvers.get(approvalId);
    if (!pendingApproval) return;

    pendingApprovalResolvers.delete(approvalId);
    const toolName = pendingApproval.toolName;

    // Legacy "Always approve entire tool" checkbox — still supported but
    // strongly discouraged. A pattern rule is the preferred path.
    if (Boolean(approved) && Boolean(alwaysApprove) && toolName) {
      setToolAlwaysApprove(toolName, true);
    }

    // New: persist a pattern rule from the approval dialog. The renderer
    // sends `alwaysAllowPattern` when the user ticks the "Always allow
    // matching 'git *'" option. `ruleAction` lets the same channel carry
    // allow/deny decisions for more advanced UI down the road.
    if (toolName && typeof addPermissionRule === 'function') {
      const pattern = typeof alwaysAllowPattern === 'string' && alwaysAllowPattern.trim()
        ? alwaysAllowPattern.trim()
        : (typeof rulePattern === 'string' && rulePattern.trim() ? rulePattern.trim() : null);
      const action = ruleAction === 'deny' ? 'deny' : (approved ? 'allow' : null);
      if (pattern && action) {
        addPermissionRule({
          tool: toolName,
          pattern,
          action,
          source: 'approval-dialog'
        });
      }
    }

    pendingApproval.resolve(Boolean(approved));
  });

  // Read current rules (for a settings UI).
  ipcMain.handle('tool:listPermissionRules', async () => {
    if (typeof getPermissionRules !== 'function') return { ok: false, error: 'rules unavailable' };
    return { ok: true, rules: getPermissionRules() };
  });

  // Remove a rule (for a settings UI).
  ipcMain.handle('tool:removePermissionRule', async (_e, payload = {}) => {
    if (typeof removePermissionRule !== 'function') return { ok: false, error: 'rules unavailable' };
    removePermissionRule(payload.tool, payload.pattern, payload.action);
    return { ok: true };
  });

  ipcMain.on(IPC.TOOL_DIRECTORY_ACCESS_RESPONSE, (_event, { requestId, approved, alwaysAllow }) => {
    if (!pendingDirectoryAccessResolvers) return;
    const pending = pendingDirectoryAccessResolvers.get(requestId);
    if (!pending) return;

    pendingDirectoryAccessResolvers.delete(requestId);

    if (Boolean(approved) && Boolean(alwaysAllow) && pending.directory) {
      try {
        const { getSettings, setSettings } = context;
        if (getSettings && setSettings) {
          const settings = getSettings();
          const dirs = Array.isArray(settings.allowedDirectories) ? [...settings.allowedDirectories] : [];
          if (!dirs.includes(pending.directory)) {
            dirs.push(pending.directory);
            settings.allowedDirectories = dirs;
            setSettings(settings);
          }
        }
      } catch (err) {
        console.warn('[tool-handlers] Failed to persist always-allow directory:', err.message);
      }
    }

    pending.resolve(Boolean(approved));
  });
}

module.exports = {
  registerToolHandlers
};