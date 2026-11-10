// One elevated schtasks call (one UAC prompt) for the boot-time personal node.
//
// The PowerShell script is a fixed literal. The schtasks path and its
// arguments travel as ONE argv element: a base64 JSON array, decoded inside
// the script, so no argument text is ever interpolated into script source.
const { execFile: nodeExecFile } = require('child_process');
const { createLogger } = require('../logging');
const { windowsPowerShellExe, windowsSchtasksExe } = require('../platform/windows-paths');

const log = createLogger('elevated-schtasks');
const ELEVATE_TIMEOUT_MS = 300000;

// Start-Process joins -ArgumentList with spaces and does not quote, so each
// element is quoted here by the CommandLineToArgvW rules: a run of backslashes
// before a quote or the end is doubled, a quote becomes \", and an element with
// whitespace or a quote (or an empty one) is wrapped in quotes.
// Windows PowerShell 5.1 hands ConvertFrom-Json's array on as ONE object, so it
// is flattened with ForEach-Object. `elevate: false` exists for the test only:
// the same script and quoting, without UAC.
function buildElevateScript({ elevate = true } = {}) {
  return [
    String.raw`& { param($b)`,
    String.raw`$ErrorActionPreference = 'Stop';`,
    String.raw`$a = @(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b))) | ForEach-Object { $_ });`,
    String.raw`function Q($s) { if ($s -ne '' -and $s -notmatch '[\s"]') { return $s };`,
    String.raw`$s = [regex]::Replace($s, '(\x5c*)"', '$1$1\"'); $s = [regex]::Replace($s, '(\x5c+)$', '$1$1');`,
    String.raw`return '"' + $s + '"' };`,
    String.raw`$rest = @($a | Select-Object -Skip 1 | ForEach-Object { Q $_ });`,
    `$p = Start-Process -FilePath $a[0] -ArgumentList $rest ${elevate ? '-Verb RunAs ' : ''}-Wait -PassThru -WindowStyle Hidden;`,
    '[Console]::Out.WriteLine($p.ExitCode) }'
  ].join(' ');
}

const ELEVATE_SCRIPT = buildElevateScript();

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

// 1223 is ERROR_CANCELLED, which a non-English Windows reports without the English words.
const CANCELED = /operation was canceled by the user|\b1223\b/i;

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
    log.warn('elevated schtasks failed', { code: err && err.code, message: String((err && err.message) || '').slice(0, 200) });
    if (CANCELED.test(text) || (err && err.code === 1223)) {
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

module.exports = { runElevatedSchtasks, buildElevateScript, ELEVATE_SCRIPT };
