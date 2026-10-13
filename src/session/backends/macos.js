// src/session/backends/macos.js
// The macOS backend (fleet stage 5 spec §3.3): a persistent JXA worker for
// CoreGraphics and AppKit, and argv-only system tools for launch and
// screenshots: /usr/bin/open, /usr/sbin/screencapture, /usr/bin/sips.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { createLogger } = require('../../logging');
const { GuiError } = require('../../gui/errors');
const { LineWorker } = require('./line-worker');

const execFileP = promisify(execFile);
const LAUNCH_PID_MS = 10000;

function createMacosBackend({ env = process.env, log = createLogger('session-helper/macos'), spawnImpl = spawn, execFileImpl = (f, a) => execFileP(f, a, { env }),
  workerFile = path.join(__dirname, 'macos-worker.js'), tmpDir = null, nodeBinary = process.execPath, worker = null } = {}) {
  const w = worker || new LineWorker({ file: '/usr/bin/osascript', args: ['-l', 'JavaScript', workerFile], spawnImpl, env, log, name: 'macos-worker' });

  function shotDir() {
    // A fresh 0700 dir per capture, inside the helper's own temp area.
    const root = tmpDir || path.join(os.tmpdir(), 'king-louie-session');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return fs.mkdtempSync(path.join(root, 'shot-'));
  }

  return {
    name: 'macos',
    probe: () => w.call('probe', { nodeBinary }),
    requestPermissions: () => w.call('request_permissions', {}, { timeoutMs: 60000 }),
    async launch({ exe, argv = [], files = [] }) {
      // A running app ignores --args unless -n opens a new instance.
      const args = argv.length ? ['-n', '-a', exe, ...files, '--args', ...argv] : ['-a', exe, ...files];
      await execFileImpl('/usr/bin/open', args);
      const deadline = Date.now() + LAUNCH_PID_MS;
      for (;;) {
        const pid = await w.call('pid_for_app', { path: exe });
        if (Number.isInteger(pid)) return { pid };
        if (Date.now() > deadline) throw new GuiError('app_not_running', `${exe} did not start within 10 s`);
        await new Promise((r) => setTimeout(r, 250));
      }
    },
    processes: ({ match }) => w.call('processes', { match }),
    windows: ({ pids }) => w.call('windows', { pids }),
    foreground: () => w.call('foreground'),
    focus: ({ handle }) => w.call('focus', { handle }),
    close: ({ pids, force }) => w.call('close', { pids, force }),
    async screenshot({ handle, maxWidth, quality }) {
      const info = await w.call('window_info', { handle });
      const dir = shotDir();
      const raw = path.join(dir, 'raw.jpg');
      const out = path.join(dir, 'out.jpg');
      try {
        await execFileImpl('/usr/sbin/screencapture', ['-x', '-o', '-l', String(info.windowNumber), '-t', 'jpg', raw]);
        await execFileImpl('/usr/bin/sips', ['--resampleWidth', String(maxWidth), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), raw, '--out', out]);
        const { stdout } = await execFileImpl('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', out]);
        const width = Number((/pixelWidth:\s*(\d+)/.exec(stdout) || [])[1]);
        const height = Number((/pixelHeight:\s*(\d+)/.exec(stdout) || [])[1]);
        if (!width || !height) throw new GuiError('backend_failed', 'sips could not read the capture');
        const data = fs.readFileSync(out).toString('base64');
        // CGEvent takes points, so the Retina scale is absorbed here (§3.5).
        return { mime: 'image/jpeg', width, height, data, transform: { sx: info.bounds.w / width, sy: info.bounds.h / height, unit: 'pt' } };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    input: ({ expect, action, yieldMs }) => w.call('input', { expect, action, yieldMs }),
    releaseAll: () => w.call('release_all'),
    locked: () => w.call('locked'),
    hitTest: ({ x, y }) => w.call('hit_test', { x, y }),
    stop: () => w.stop()
  };
}

module.exports = { createMacosBackend };
