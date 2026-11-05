// Renderer-backed prompter. The window and resolver maps are injected by
// main.js, so this module never requires electron.
const ASK_USER_TIMEOUT_MS = 5 * 60 * 1000;
const DIRECTORY_ACCESS_TIMEOUT_MS = 2 * 60 * 1000;
const STOPPED = 'Stopped.';

const newRequestId = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function createElectronPrompter({ getWindow, pendingAskUserResolvers, pendingDirectoryAccessResolvers }) {
  const liveWindow = () => {
    const win = typeof getWindow === 'function' ? getWindow() : null;
    return win && !(typeof win.isDestroyed === 'function' && win.isDestroyed()) ? win : null;
  };

  return {
    // `signal` is the run's: Stop ends the wait, so no turn stays blocked behind it.
    askUser({ question, signal = null }) {
      if (signal?.aborted) return Promise.resolve({ ok: false, error: STOPPED });
      const win = liveWindow();
      if (!win) return Promise.resolve({ ok: false, error: 'No UI available to ask user.' });
      return new Promise((resolve) => {
        const requestId = newRequestId('ask');
        const onAbort = () => {
          clearTimeout(timeoutId);
          pendingAskUserResolvers.delete(requestId);
          // Or the row stays on screen, and an answer typed there goes nowhere.
          liveWindow()?.webContents.send('agent:askEnded', { requestId });
          resolve({ ok: false, error: STOPPED });
        };
        const timeoutId = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          pendingAskUserResolvers.delete(requestId);
          resolve({ ok: false, error: 'User did not respond within 5 minutes.' });
        }, ASK_USER_TIMEOUT_MS);
        timeoutId.unref?.();
        signal?.addEventListener('abort', onAbort, { once: true });
        pendingAskUserResolvers.set(requestId, {
          resolve: (userResponse) => {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', onAbort);
            resolve({ ok: true, response: userResponse });
          }
        });
        win.webContents.send('agent:askUser', { requestId, question });
      });
    },

    requestDirectoryAccess({ directory, toolName, signal = null }) {
      if (signal?.aborted) return Promise.resolve(false);
      const win = liveWindow();
      if (!win) return Promise.resolve(false);
      return new Promise((resolve) => {
        const requestId = newRequestId('diraccess');
        const onAbort = () => {
          clearTimeout(timeoutId);
          pendingDirectoryAccessResolvers.delete(requestId);
          resolve(false);
        };
        const timeoutId = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          pendingDirectoryAccessResolvers.delete(requestId);
          resolve(false);
        }, DIRECTORY_ACCESS_TIMEOUT_MS);
        timeoutId.unref?.();
        signal?.addEventListener('abort', onAbort, { once: true });
        pendingDirectoryAccessResolvers.set(requestId, {
          directory,
          resolve: (approved) => {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', onAbort);
            resolve(approved === true);
          }
        });
        win.webContents.send('tool:directoryAccessRequired', { requestId, directory, toolName });
      });
    }
  };
}

module.exports = { createElectronPrompter };
