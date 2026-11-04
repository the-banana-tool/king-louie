const { wrapHandler } = require('./wrap-handler');
const IPC = require('./constants');
const path = require('path');
const { isRemoteWindowEvent } = require('../core/origin');

const COMMIT_ID = /^[0-9a-f]{40}$/;
// How far back a remote window's checkpoint:changes looks for the id it names.
const COMMIT_LOOKUP = 500;
const NOT_HERE = 'That is not a checkpoint of this directory.';
const PATH_REFUSED = 'A remote window reads the checkpoints of an allowed directory or a chat\'s working directory only.';
const sameCase = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

function isAtOrUnder(parent, child) {
  const relative = path.relative(sameCase(path.resolve(parent)), sameCase(path.resolve(child)));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

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

  // The directories a remote window may name: the allowed ones, each chat's
  // working directory (a phone approval set it) and the host's own.
  const remoteMayRead = (dir) => {
    if (typeof dir !== 'string' || !dir) return false;
    const roots = [];
    try {
      roots.push(...(context.getSettings?.()?.allowedDirectories || []));
      roots.push(...(context.listChats?.() || []).map((chat) => chat && chat.workingDirectory));
      roots.push(context.getWorkingDirectory?.());
    } catch {
      return false;
    }
    return roots.some((root) => typeof root === 'string' && root && isAtOrUnder(root, dir));
  };

  ipcMain.handle(IPC.CHECKPOINT_LIST, wrapHandler(IPC.CHECKPOINT_LIST, async (event, { workingDirectory, limit } = {}) => {
    const manager = getManager();
    if (!manager) return { ok: false, error: 'Checkpoints are not enabled.', checkpoints: [] };
    if (isRemoteWindowEvent(event) && !remoteMayRead(getWorkingDirectory(workingDirectory))) {
      return { ok: false, code: 'REMOTE_PATH_REFUSED', error: PATH_REFUSED, checkpoints: [] };
    }

    const checkpoints = await manager.list(getWorkingDirectory(workingDirectory), { limit });
    return { ok: true, checkpoints };
  }));

  ipcMain.handle(IPC.CHECKPOINT_CHANGES, wrapHandler(IPC.CHECKPOINT_CHANGES, async (event, { workingDirectory, checkpointId } = {}) => {
    const manager = getManager();
    if (!manager) return { ok: false, error: 'Checkpoints are not enabled.', changes: [] };
    if (!checkpointId) return { ok: false, error: 'checkpointId is required.', changes: [] };
    if (isRemoteWindowEvent(event)) {
      // The id reaches git as an argument, so it must be a commit id before
      // anything else; and the manager reads any project's commit, so it must
      // be one of this directory's.
      if (typeof checkpointId !== 'string' || !COMMIT_ID.test(checkpointId)) return { ok: false, code: 'CHECKPOINT_NOT_HERE', error: NOT_HERE, changes: [] };
      const dir = getWorkingDirectory(workingDirectory);
      if (!remoteMayRead(dir)) return { ok: false, code: 'REMOTE_PATH_REFUSED', error: PATH_REFUSED, changes: [] };
      const known = await manager.list(dir, { limit: COMMIT_LOOKUP });
      if (!known.some((checkpoint) => checkpoint.id === checkpointId)) return { ok: false, code: 'CHECKPOINT_NOT_HERE', error: NOT_HERE, changes: [] };
    }

    const changes = await manager.changes(getWorkingDirectory(workingDirectory), checkpointId);
    return { ok: true, changes };
  }));

  ipcMain.handle(IPC.CHECKPOINT_RESTORE, wrapHandler(IPC.CHECKPOINT_RESTORE, async (event, { workingDirectory, checkpointId } = {}) => {
    const manager = getManager();
    if (!manager) return { ok: false, error: 'Checkpoints are not enabled.' };
    if (!checkpointId) return { ok: false, error: 'checkpointId is required.' };
    if (isRemoteWindowEvent(event) && (typeof checkpointId !== 'string' || !COMMIT_ID.test(checkpointId))) return { ok: false, code: 'CHECKPOINT_NOT_HERE', error: NOT_HERE };

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
