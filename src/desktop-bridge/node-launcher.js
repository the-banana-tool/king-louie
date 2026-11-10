// `King Louie.exe --kl-node-service <entry> run ...`: the boot task's launch.
// The app binary re-runs itself as plain Node (ELECTRON_RUN_AS_NODE=1) with no
// console window, waits for the child and hands back its exit code. It takes no
// single-instance lock, so an open desktop window never stops the node.
const { spawn: nodeSpawn } = require('child_process');

const FLAG = '--kl-node-service';

function isNodeServiceLaunch(argv) {
  return Array.isArray(argv) && argv.slice(1).includes(FLAG);
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

module.exports = { FLAG, isNodeServiceLaunch, runNodeService };
