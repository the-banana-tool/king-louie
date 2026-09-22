// Renderer-backed prompter. The window and resolver maps are injected by
// main.js, so this module never requires electron.
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000;
const DIRECTORY_ACCESS_TIMEOUT_MS = 2 * 60 * 1000;

const newRequestId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function createElectronPrompter({ getWindow, pendingAskUserResolvers, pendingDirectoryAccessResolvers }) {
  const liveWindow = () => {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    return win && !(typeof win.isDestroyed === 'function' && win.isDestroyed()) ? win : null;
  };

  return {
    askUser({ question }) {
      const win = liveWindow();
      if (!win) return Promise.resolve({ ok: false, error: 'No UI available to ask user.' });
      return new Promise((resolve) => {
        const requestId = newRequestId('ask');
        const timeoutId = setTimeout(() => {
          pendingAskUserResolvers.delete(requestId);
          resolve({ ok: false, error: 'User did not respond within 5 minutes.' });
        }, ASK_USER_TIMEOUT_MS);
        timeoutId.unref?.();
        pendingAskUserResolvers.set(requestId, {
          resolve: (userResponse) => {
            clearTimeout(timeoutId);
            resolve({ ok: true, response: userResponse });
          }
        });
        win.webContents.send('agent:askUser', { requestId, question });
      });
    },

    requestDirectoryAccess({ directory, toolName }) {
      const win = liveWindow();
      if (!win) return Promise.resolve(false);
      return new Promise((resolve) => {
        const requestId = newRequestId('diraccess');
        const timeoutId = setTimeout(() => {
          pendingDirectoryAccessResolvers.delete(requestId);
          resolve(false);
        }, DIRECTORY_ACCESS_TIMEOUT_MS);
        timeoutId.unref?.();
        pendingDirectoryAccessResolvers.set(requestId, {
          directory,
          resolve: (approved) => {
            clearTimeout(timeoutId);
            resolve(approved === true);
          }
        });
        win.webContents.send('tool:directoryAccessRequired', { requestId, directory, toolName });
      });
    }
  };
}

module.exports = { createElectronPrompter };
