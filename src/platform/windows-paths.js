// Absolute paths for the Windows system executables king-louie runs, so a
// process started from an attacker-writable cwd can't pick up a planted
// powershell.exe/schtasks.exe (Windows searches the cwd before PATH).
const path = require('path');

function windowsSystemRoot(env = process.env) {
  const root = env.SystemRoot;
  return typeof root === 'string' && path.win32.isAbsolute(root) ? root : 'C:\\Windows';
}

const windowsPowerShellExe = (env) => path.win32.join(windowsSystemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const windowsSchtasksExe = (env) => path.win32.join(windowsSystemRoot(env), 'System32', 'schtasks.exe');

module.exports = { windowsSystemRoot, windowsPowerShellExe, windowsSchtasksExe };
