// tests/helpers/windows-powershell-env.js
// The environment for a Windows PowerShell 5.1 child that calls a module
// cmdlet such as Get-Acl (Microsoft.PowerShell.Security).
//
// pwsh 7 puts its own module directories at the front of PSModulePath, and a
// node process started from a pwsh prompt (every `run:` step on a GitHub
// Windows runner) passes them on. Windows PowerShell then autoloads PS7's
// Microsoft.PowerShell.Security, which it cannot load: Get-Acl fails with
// "found in the module ... but the module could not be loaded", as a
// non-terminating error, so the exit code stays 0 and only the output is
// missing. pwsh strips its paths when it starts powershell.exe itself; node
// does not. Without the variable, Windows PowerShell builds its own default.
//
// src/ needs none of this: its scripts use framework types and Add-Type,
// never a Microsoft.PowerShell.Security cmdlet (see approver-store.js and
// inspectDirAcl in service-installers.test.js).
function windowsPowerShellEnv(extra = {}, env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() !== 'PSMODULEPATH') out[key] = value;
  }
  return { ...out, ...extra };
}

module.exports = { windowsPowerShellEnv };
