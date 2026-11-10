// King Louie's start at login (boot-node-tray spec §5.4, C-8): one per-user Run
// value, HKCU\Software\Microsoft\Windows\CurrentVersion\Run "King Louie", whose data
// starts the installed app hidden in the tray. Electron-free: `install --personal`
// sets it from the CLI, and the window's setting reads and sets the same value.
// reg.exe by absolute path, arguments as an array; nothing goes through a shell.
const { execFileSync } = require('child_process');
const { windowsRegExe } = require('../platform/windows-paths');
const { sanitizeWindowsPath } = require('../service/installers');

const LOGIN_START_VALUE = 'King Louie';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const TRAY_ARG = '--kl-tray';
// `    King Louie    REG_SZ    "<app>" --kl-tray`: the name, then the type, then the data.
const VALUE_LINE = /^\s*King Louie\s+REG_(?:EXPAND_)?SZ\s+(.*)$/;
const REG_OPTIONS ={ encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] };

const loginStartCommand = (appPath) => `"${sanitizeWindowsPath('appPath', appPath)}" ${TRAY_ARG}`;

// → { on, command }: on when the value is there, command its data.
function readLoginStart({ execFile = execFileSync, env = process.env } = {}) {
  let out;
  try {
    out = String(execFile(windowsRegExe(env), ['query', RUN_KEY, '/v', LOGIN_START_VALUE], REG_OPTIONS));
  } catch {
    // reg query exits 1 when the value is not there.
    return { on: false, command: null };
  }
  for (const line of out.split(/\r?\n/)) {
    const m = VALUE_LINE.exec(line);
    if (m) return { on: true, command: m[1].trim() };
  }
  return { on: false, command: null };
}

// Throws when reg.exe fails, except that turning off a value that is not there is done.
function setLoginStart({ on, appPath } = {}, { execFile = execFileSync, env = process.env } = {}) {
  const reg = windowsRegExe(env);
  if (on) {
    execFile(reg, ['add', RUN_KEY, '/v', LOGIN_START_VALUE, '/t', 'REG_SZ', '/d', loginStartCommand(appPath), '/f'], REG_OPTIONS);
    return;
  }
  try {
    execFile(reg, ['delete', RUN_KEY, '/v', LOGIN_START_VALUE, '/f'], REG_OPTIONS);
  } catch (err) {
    const text = `${err && err.stderr ? err.stderr : ''} ${err && err.message ? err.message : ''}`;
    if (/unable to find/i.test(text)) return;
    // A non-English reg says it in other words: gone is gone.
    if (!readLoginStart({ execFile, env }).on) return;
    throw err;
  }
}

module.exports = { readLoginStart, setLoginStart, loginStartCommand, LOGIN_START_VALUE, RUN_KEY, TRAY_ARG };
