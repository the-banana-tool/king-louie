// "Is this process root / an elevated Administrator?" for admin-only commands.
//
// The Windows check never builds a command string from a path: the
// PowerShell snippet is a fixed literal with nothing interpolated into it,
// and every argument to execFile is a plain array entry, not shell text.
// Tests inject `execFile` so they exercise this without actually shelling
// out to PowerShell.
const { execFileSync } = require('child_process');
const { windowsPowerShellExe } = require('../../platform/windows-paths');

const IS_ADMIN_SCRIPT = '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';

function isAdmin({
  platform = process.platform,
  geteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1),
  execFile = execFileSync,
  env = process.env
} = {}) {
  if (platform === 'win32') {
    try {
      const out = execFile(windowsPowerShellExe(env), ['-NoProfile', '-NonInteractive', '-Command', IS_ADMIN_SCRIPT], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      return String(out).trim() === 'True';
    } catch {
      return false;
    }
  }
  return geteuid() === 0;
}

module.exports = { isAdmin };
