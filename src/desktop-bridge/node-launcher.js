// `King Louie.exe --kl-node-service <entry> run ...`: the boot task's launch.
// The app binary re-runs itself as plain Node (ELECTRON_RUN_AS_NODE=1) with no
// console window, waits for the child and hands back its exit code. It takes no
// single-instance lock, so an open desktop window never stops the node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn: nodeSpawn } = require('child_process');

const FLAG = '--kl-node-service';
const LAUNCHER_DIR_NAME = 'king-louie-node-launcher';

function isNodeServiceLaunch(argv) {
  return Array.isArray(argv) && argv.slice(1).includes(FLAG);
}

// The launcher is still the Electron binary, and Electron's browser process
// starts on whatever userData it is given. At boot the task can run before the
// owner logs in, so it must never open (or lock) the desktop app's own profile:
// its userData goes to a throwaway folder under the temp dir, and no GPU process
// starts. `app` is passed in: this module stays Electron-free.
function prepareLauncherApp(app, { tmpdir = os.tmpdir(), mkdir = fs.mkdirSync } = {}) {
  const dir = path.join(tmpdir, LAUNCHER_DIR_NAME);
  try { mkdir(dir, { recursive: true }); } catch { /* setPath still points Electron away from the profile */ }
  app.setPath('userData', dir);
  app.disableHardwareAcceleration();
  return dir;
}

function runNodeService({ argv = process.argv, execPath = process.execPath, env = process.env, spawn = nodeSpawn } = {}) {
  const at = argv.indexOf(FLAG);
  const args = at === -1 ? [] : argv.slice(at + 1);
  return new Promise((resolve) => {
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    let child;
    try {
      child = spawn(execPath, args, {
        env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      done(1);
      return;
    }
    const forward = (signal) => () => { try { child.kill(signal); } catch { /* already gone */ } };
    const onTerm = forward('SIGTERM');
    const onInt = forward('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    const finish = (code) => {
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onInt);
      done(code);
    };
    child.on('error', () => finish(1));
    child.on('exit', (code) => finish(typeof code === 'number' ? code : 1));
  });
}

// main.js's one call for the launch: the temp userData first, then the node, then its exit code.
function runLauncher(app, { argv = process.argv, execPath = process.execPath, env = process.env, spawn = nodeSpawn, exit = (code) => process.exit(code), prepare = {} } = {}) {
  prepareLauncherApp(app, prepare);
  return runNodeService({ argv, execPath, env, spawn }).then((code) => { exit(code); return code; });
}

module.exports = { FLAG, LAUNCHER_DIR_NAME, isNodeServiceLaunch, prepareLauncherApp, runLauncher, runNodeService };
