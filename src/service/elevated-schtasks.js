// One elevated schtasks call (one UAC prompt) for the boot-time personal node.
//
// The PowerShell script is a fixed literal. The schtasks path and its
// arguments travel as ONE argv element: a base64 JSON array, decoded inside
// the script, so no argument text is ever interpolated into script source.
const { execFile: nodeExecFile } = require('child_process');
const { windowsPowerShellExe, windowsSchtasksExe } = require('../platform/windows-paths');

const ELEVATE_TIMEOUT_MS = 300000;

// Start-Process joins -ArgumentList with spaces and does not quote, so an
// element holding whitespace or a quote is wrapped here, inside PowerShell.
const ELEVATE_SCRIPT = [
  '& { param($b)',
  '$ErrorActionPreference = "Stop";',
  '$a = @([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)) | ConvertFrom-Json);',
  '$rest = @($a | Select-Object -Skip 1 | ForEach-Object { if ($_ -match \'[\\s"]\' -or $_ -eq "") { \'"\' + ($_ -replace \'"\', \'\\"\') + \'"\' } else { $_ } });',
  '$p = Start-Process -FilePath $a[0] -ArgumentList $rest -Verb RunAs -Wait -PassThru -WindowStyle Hidden;',
  '[Console]::Out.WriteLine($p.ExitCode) }'
].join(' ');

function runDefault(file, args, options) {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, options, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

const CANCELED = /operation was canceled by the user/i;

async function runElevatedSchtasks(args, { execFile = runDefault, env = process.env } = {}) {
  const blob = Buffer.from(JSON.stringify([windowsSchtasksExe(env), ...args]), 'utf8').toString('base64');
  let result;
  try {
    result = await execFile(
      windowsPowerShellExe(env),
      ['-NoProfile', '-NonInteractive', '-Command', ELEVATE_SCRIPT, blob],
      { encoding: 'utf8', windowsHide: true, timeout: ELEVATE_TIMEOUT_MS }
    );
  } catch (err) {
    const text = `${err && err.stderr ? err.stderr : ''} ${err && err.message ? err.message : ''}`;
    if (CANCELED.test(text)) {
      return { ok: false, code: 'UAC_DECLINED', message: 'The administrator prompt was declined.' };
    }
    return { ok: false, code: 'SCHTASKS_FAILED', message: 'The elevated step could not be run.' };
  }
  const stdout = typeof result === 'string' ? result : (result && result.stdout) || '';
  const text = String(stdout).trim();
  if (!/^-?\d+$/.test(text)) {
    return { ok: false, code: 'SCHTASKS_FAILED', message: 'The elevated step gave no exit code.' };
  }
  const exitCode = Number(text);
  if (exitCode !== 0) {
    return { ok: false, code: 'SCHTASKS_FAILED', exitCode, message: `schtasks exited with code ${exitCode}.` };
  }
  return { ok: true };
}

module.exports = { runElevatedSchtasks, ELEVATE_SCRIPT };
