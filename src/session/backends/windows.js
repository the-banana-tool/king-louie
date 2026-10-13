// src/session/backends/windows.js
// The Windows backend (fleet stage 5 spec §3.3): one persistent PowerShell
// worker running C# through Add-Type, plus Node's own spawn for launches.
const path = require('path');
const { spawn } = require('child_process');
const { createLogger } = require('../../logging');
const { windowsPowerShellExe } = require('../../platform/windows-paths');
const { GuiError } = require('../../gui/errors');
const { LineWorker } = require('./line-worker');

function createWindowsBackend({ env = process.env, log = createLogger('session-helper/windows'), spawnImpl = spawn, workerFile = path.join(__dirname, 'windows-worker.ps1') } = {}) {
  const worker = new LineWorker({
    file: windowsPowerShellExe(env),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', workerFile],
    spawnImpl, env, log, name: 'windows-worker'
  });
  return {
    name: 'windows',
    // The first call compiles the C#: allow it a minute.
    probe: () => worker.call('probe', {}, { timeoutMs: 60000 }),
    async launch({ exe, argv = [], files = [] }) {
      if (!/\.exe$/i.test(String(exe))) throw new GuiError('app_type_not_supported', 'only .exe files can be launched on Windows');
      // Not hidden (Deviation 17): the app's first window must show.
      const child = spawnImpl(exe, [...argv, ...files], { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', (err) => reject(new GuiError('file_not_found', err.message)));
      });
      child.unref();
      return { pid: child.pid };
    },
    processes: ({ match }) => worker.call('processes', { match }),
    windows: ({ pids }) => worker.call('windows', { pids }),
    foreground: () => worker.call('foreground'),
    focus: ({ handle }) => worker.call('focus', { handle }),
    close: ({ pids, force }) => worker.call('close', { pids, force }),
    screenshot: ({ handle, maxWidth, quality }) => worker.call('screenshot', { handle, maxWidth, quality }, { timeoutMs: 20000 }),
    input: ({ expect, action, yieldMs }) => worker.call('input', { expect, action, yieldMs }),
    releaseAll: () => worker.call('release_all'),
    locked: () => worker.call('locked'),
    hitTest: ({ x, y }) => worker.call('hit_test', { x, y }),
    stop: () => worker.stop()
  };
}

module.exports = { createWindowsBackend };
