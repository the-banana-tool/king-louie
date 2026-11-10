// "Is this process root / an elevated Administrator?" for admin-only commands.
//
// The Windows check never builds a command string from a path: the
// PowerShell snippet is a fixed literal with nothing interpolated into it,
// and every argument to execFile is a plain array entry, not shell text.
// Tests inject `execFile` so they exercise this without actually shelling
// out to PowerShell.
const { execFileSync } = require('child_process');
const path = require('path');
const { windowsPowerShellExe, windowsSystemRoot } = require('../../platform/windows-paths');

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

// True when the Administrators group (S-1-5-32-544) is in the token, even as
// deny-only: an unelevated member of Administrators still has it listed.
function isAdministratorsMember({ execFile = execFileSync, env = process.env } = {}) {
  try {
    const exe = path.win32.join(windowsSystemRoot(env), 'System32', 'whoami.exe');
    const out = execFile(exe, ['/groups', '/fo', 'csv'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    return String(out).split(/\r?\n/).some((line) => line.split(',').some((cell) => cell.replace(/"/g, '').trim() === 'S-1-5-32-544'));
  } catch {
    return false;
  }
}

module.exports = { isAdmin, isAdministratorsMember };
