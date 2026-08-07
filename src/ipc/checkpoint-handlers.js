const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');

/**
 * IPC surface for turn checkpoints.
 *
 * Read/list/diff are safe. Restore overwrites the user's working directory,
 * so it is only ever reached by explicit user action in the UI — no tool and
 * no agent can invoke these channels.
 */
function registerCheckpointHandlers(ipcMain, context = {}) {
  const getManager = () => (
    typeof context.getCheckpointManager === 'function'
      ? context.getCheckpointManager()
      : context.checkpointManager
  );

  const getWorkingDirectory = (supplied) => {
    if (supplied) return supplied;
    return typeof context.getWorkingDirectory === 'function'
      ? context.getWorkingDirectory()
      : process.cwd();
  };

  ipcMain.handle(IPC.CHECKPOINT_LIST, wrapHandler(IPC.CHECKPOINT_LIST, async (_event, { workingDirectory, limit } = {}) => {
    const manager = getManager();
    if (!manager) return { ok: false, error: 'Checkpoints are not enabled.', checkpoints: [] };

    const checkpoints = await manager.list(getWorkingDirectory(workingDirectory), { limit });
    return { ok: true, checkpoints };
  }));

  ipcMain.handle(IPC.CHECKPOINT_CHANGES, wrapHandler(IPC.CHECKPOINT_CHANGES, async (_event, { workingDirectory, checkpointId } = {}) => {
    const manager = getManager();
    if (!manager) return { ok: false, error: 'Checkpoints are not enabled.', changes: [] };
    if (!checkpointId) return { ok: false, error: 'checkpointId is required.', changes: [] };

    const changes = await manager.changes(getWorkingDirectory(workingDirectory), checkpointId);
    return { ok: true, changes };
  }));

  ipcMain.handle(IPC.CHECKPOINT_RESTORE, wrapHandler(IPC.CHECKPOINT_RESTORE, async (_event, { workingDirectory, checkpointId } = {}) => {
    const manager = getManager();
    if (!manager) return { ok: false, error: 'Checkpoints are not enabled.' };
    if (!checkpointId) return { ok: false, error: 'checkpointId is required.' };

    const result = await manager.restore(getWorkingDirectory(workingDirectory), checkpointId);
    return { ok: true, ...result };
  }));

  ipcMain.handle(IPC.CHECKPOINT_PRUNE, wrapHandler(IPC.CHECKPOINT_PRUNE, async (_event, { force } = {}) => {
    const manager = getManager();
    if (!manager) return { ok: false, error: 'Checkpoints are not enabled.' };

    const result = await manager.prune({ force: Boolean(force) });
    return { ok: true, ...result };
  }));

  ipcMain.handle(IPC.CHECKPOINT_GET_STATUS, wrapHandler(IPC.CHECKPOINT_GET_STATUS, async () => {
    const manager = getManager();
    return {
      ok: true,
      enabled: Boolean(manager?.enabled),
      available: Boolean(manager)
    };
  }));

  ipcMain.handle(IPC.CHECKPOINT_SET_ENABLED, wrapHandler(IPC.CHECKPOINT_SET_ENABLED, async (_event, { enabled } = {}) => {
    const manager = getManager();
    if (!manager) return { ok: false, error: 'Checkpoints are not available.' };

    const next = Boolean(enabled);

    // Flip the live manager as well as the persisted setting, so the change
    // takes effect for the very next turn rather than after a restart.
    manager.enabled = next;

    if (typeof context.getSettings === 'function' && typeof context.setSettings === 'function') {
      const settings = context.getSettings() || {};
      context.setSettings({
        ...settings,
        checkpoints: { ...(settings.checkpoints || {}), enabled: next }
      });
    }

    return { ok: true, enabled: next };
  }));
}

module.exports = { registerCheckpointHandlers };
