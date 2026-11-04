// Whether a command is on PATH, for the lookups a host runs at start. The
// service's working directory is <dataDir>/workspace, where the model can
// write, so a lookup never runs a program by bare name, never goes through
// cmd.exe (which searches the cwd first) and runs from a directory of its own:
// `where` also searches its cwd, and a relative PATH entry resolves against it.
const { execFile } = require('child_process');
const { promisify } = require('util');
const { windowsSystem32, windowsWhereExe } = require('../platform/windows-paths');

const execFileAsync = promisify(execFile);

// Where a lookup's own children run: nothing the model can write.
const safeCwd = () => (process.platform === 'win32' ? windowsSystem32(process.env) : '/');

// A program by absolute path, with no shell. Rejects on a non-zero exit.
function runProgram(file, args, { timeout = 5000 } = {}) {
  return execFileAsync(file, args, { cwd: safeCwd(), windowsHide: true, timeout, shell: false });
}

// → the first path the lookup found, or null. The name goes as an argument.
async function lookupCommand(name, { timeout = 5000 } = {}) {
  try {
    const { stdout } = process.platform === 'win32'
      ? await runProgram(windowsWhereExe(process.env), [name], { timeout })
      : await runProgram('/bin/sh', ['-c', 'command -v -- "$1"', 'sh', name], { timeout });
    return stdout.trim().split('\n')[0].trim() || null;
  } catch {
    return null;
  }
}

module.exports = { lookupCommand, runProgram };
