// `install --personal` and `uninstall --personal` (personal node spec
// 2026-10-25-personal-node-design.md §8): the service in the owner's own
// login session, as the owner, installed by one unelevated command. It
// writes the config dir and node.yaml as the owner (nothing here runs
// elevated, so nothing is handed between accounts) and registers a logon
// task for the owner's SID through the same schtasks path the session
// helper's login start uses (src/session/autostart.js).
//
// CLI output goes to stdout/stderr on purpose; everything else logs via createLogger.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { sanitizeWindowsPath, xmlEscape, executeSteps } = require('./installers');
const { windowsSystemRoot, windowsSchtasksExe, windowsPowerShellExe } = require('../platform/windows-paths');
const { ensurePrivateDir } = require('../platform/paths');
const { parseYaml } = require('../platform/yaml');
const { parseGuiConfig } = require('../gui/config');
const { shown } = require('./commands/io');

const PERSONAL_TASK_NAME = 'KingLouie Node';
const FLEET_TASK_NAME = 'KingLouie';
const SID_RE = /^S-1-\d+(-\d+){1,14}$/;
const NODE_YAML = 'node.yaml';
// src/fleet/front-door-pin.js's PIN_FILE (not required here: it loads the mesh).
const FRONT_DOOR_PIN = 'front-door.json';
const NOTHING_PAIRED = `${NODE_YAML} has no approvers.relay and there is no ${FRONT_DOOR_PIN} yet: pair (wss://<relay> or https://mcp.<domain>) writes one and starts the task`;

const TRUST_LINE = 'the service will run as this account; the owner account is the trust boundary: anything running as you can drive it as a local mcp client and change its approver set, and a shell the phone approves can do anything you can';
const REBOOT_LINE = 'a logon task: after a reboot the node is down until you log in (the phones show "Could not confirm" and a take cannot start)';
const FFMPEG_LINE = 'ffmpeg is not on PATH: a take that records needs it. Install it as yourself: winget install Gyan.FFmpeg';

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function renderPersonalTaskXml({ sid, nodePath, entryPath, dataDir, env = process.env }) {
  if (!SID_RE.test(String(sid))) throw new Error('the task needs the account\'s SID');
  const node = sanitizeWindowsPath('nodePath', nodePath);
  const entry = sanitizeWindowsPath('entryPath', entryPath);
  const dir = sanitizeWindowsPath('dataDir', dataDir);
  const args = `-WindowStyle Hidden -NoProfile -NonInteractive -Command & ${psQuote(node)} ${psQuote(entry)} run --data-dir ${psQuote(dir)}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>King Louie personal node</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger></Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${sid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(windowsPowerShellExe(env))}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

// --- defaults (each one replaced in tests) ---

const system32 = (env, exe) => path.win32.join(windowsSystemRoot(env), 'System32', exe);

// `whoami /user /fo csv`: a header line, then "domain\user","S-1-…".
function defaultWhoAmI(env) {
  const out = String(execFileSync(system32(env, 'whoami.exe'), ['/user', '/fo', 'csv'], { encoding: 'utf8', windowsHide: true, timeout: 30000 }));
  const line = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
  const m = /^"([^"]*)","([^"]*)"$/.exec(line);
  if (!m) throw new Error('whoami /user gave no account and SID');
  return { user: m[1], sid: m[2] };
}

// Chrome's registered App Path, machine-wide first, then the user's own.
function defaultFindChrome(env) {
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const out = String(execFileSync(system32(env, 'reg.exe'), ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }));
      const m = /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(out);
      const exe = m ? m[1].trim().replace(/^"(.*)"$/, '$1') : null;
      if (exe && fs.existsSync(exe)) return exe;
    } catch { /* not registered in this hive */ }
  }
  return null;
}

function taskExists(env, name) {
  try {
    execFileSync(windowsSchtasksExe(env), ['/Query', '/TN', name], { stdio: 'ignore', windowsHide: true, timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

// A fleet node: the KingLouie boot task, or one of the fleet layout's
// marker files (§8 step 0), the same list the default data dir rule reads
// (paths.js fleetLayoutMarkers). → { task, marker: <path> | null }.
function defaultFleetInstalled(env) {
  const task = taskExists(env, FLEET_TASK_NAME);
  const marker = require('../platform/paths').fleetLayoutExists({ env });
  return { task, marker };
}

// The refusal for a fleet node found: with the task, the fleet uninstall
// removes it; a marker file alone is removed by nothing the CLI runs.
function fleetRefusal({ task, marker }) {
  if (task) {
    const what = [`the ${FLEET_TASK_NAME} scheduled task`, marker && `${marker} exists`].filter(Boolean).join('; ');
    return `a fleet node is installed on this machine (${what}); run uninstall / session uninstall first`;
  }
  return `a fleet node's file is on this machine (${marker}) with no ${FLEET_TASK_NAME} task: if no fleet node is meant to run here, remove that file by hand, then run this again`;
}

function readYaml(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return { error: err };
  }
}

// Whether the node.yaml in configDir is one the started task would run:
// it loads through loadNodeConfig with hosting: personal and
// approvers.relay set or a front door pinned in <configDir>/front-door.json
// (what the node links to: service-wiring.js prefers the pin).
// → { ok: true } or { ok: false, why } (one line).
function defaultStartable(configDir) {
  let config;
  try {
    const uid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
    config = require('./node-config').loadNodeConfig({ adminConfigDir: configDir, adminUid: uid });
  } catch (err) {
    return { ok: false, why: `${NODE_YAML} does not load (${shown(err.message)})` };
  }
  if (config.hosting !== 'personal') return { ok: false, why: `${NODE_YAML} lacks hosting: personal` };
  if (config.approvers && typeof config.approvers.relay === 'string' && config.approvers.relay.trim()) return { ok: true };
  // lstat, as the pin reader does: a link is refused there, never followed.
  let st;
  try {
    st = fs.lstatSync(path.join(configDir, FRONT_DOOR_PIN));
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: false, why: NOTHING_PAIRED };
    return { ok: false, why: `${FRONT_DOOR_PIN} cannot be read (${shown(err.message)})` };
  }
  if (st.isSymbolicLink()) return { ok: false, why: `${FRONT_DOOR_PIN} is a link, which the node refuses` };
  if (!st.isFile()) return { ok: false, why: `${FRONT_DOOR_PIN} is not a regular file` };
  return { ok: true };
}

function resolveDeps(deps, io) {
  const env = deps.env || process.env;
  return {
    platform: deps.platform || process.platform,
    env,
    isAdmin: deps.isAdmin || (() => require('./commands/admin-check').isAdmin({ env })),
    isTTY: deps.isTTY || (() => Boolean(io && io.stdin && io.stdin.isTTY)),
    confirm: deps.confirm || ((question) => require('./commands/desktop').defaultConfirm(io, question)),
    whoAmI: deps.whoAmI || (() => defaultWhoAmI(env)),
    findChrome: deps.findChrome || (() => defaultFindChrome(env)),
    findFfmpeg: deps.findFfmpeg || (() => require('../session/recorder').findFfmpeg({ env })),
    fleetInstalled: deps.fleetInstalled || (() => defaultFleetInstalled(env)),
    startable: deps.startable || defaultStartable,
    taskRegistered: deps.taskRegistered || (() => taskExists(env, PERSONAL_TASK_NAME)),
    exists: deps.exists || fs.existsSync,
    hostname: deps.hostname || os.hostname,
    tmpDir: deps.tmpDir || os.tmpdir(),
    execute: deps.execute || ((steps) => executeSteps(steps, { io })),
    nodePath: deps.nodePath || process.execPath,
    entryPath: deps.entryPath || path.resolve(__dirname, '..', '..', 'bin', 'king-louie-service.js')
  };
}

// --- node.yaml ---

// A YAML string scalar, always single-quoted, so a value that reads as
// another type plain (`true`, `null`, `123`, `1e3`, `on`, a numeric
// hostname) stays a string.
const scalar = (v) => `'${String(v).replace(/'/g, "''")}'`;

// The values node.yaml gets, as dotted paths, in the order they are written.
function wantedLeaves({ name, chrome, provider, model }) {
  const leaves = [
    ['name', name],
    ['profile', 'agent'],
    ['hosting', 'personal'],
    ['gui.enabled', true],
    ['gui.apps.chrome', chrome],
    ['gui.take.enabled', true],
    ['gui.take.max_minutes', 240],
    ['gui.browser', 'chrome']
  ];
  if (provider) leaves.push(['delegate.provider', provider]);
  if (model) leaves.push(['delegate.model', model]);
  return leaves;
}

function renderNodeYaml({ name, chrome, provider, model }) {
  const lines = [
    `name: ${scalar(name)}`,
    'profile: agent',
    'hosting: personal',
    'gui:',
    '  enabled: true',
    '  apps:',
    `    chrome: ${scalar(chrome)}`,
    '  take:',
    '    enabled: true',
    '    max_minutes: 240',
    '  browser: chrome'
  ];
  if (provider || model) {
    lines.push('delegate:');
    if (provider) lines.push(`  provider: ${scalar(provider)}`);
    if (model) lines.push(`  model: ${scalar(model)}`);
  }
  return `${lines.join('\n')}\n`;
}

// The wanted lines an existing node.yaml does not have (any `name` will do,
// and a browser it already names is its own choice).
function missingLines(text, wanted) {
  let parsed;
  try {
    parsed = parseYaml(text);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const at = (dotted) => dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), parsed);
  const hasBrowser = at('gui.browser') !== undefined;
  return wanted
    .filter(([key]) => key !== 'name' && !(hasBrowser && (key === 'gui.browser' || key === 'gui.apps.chrome')))
    .filter(([key, value]) => at(key) !== value)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? scalar(value) : value}`);
}

// --- the commands ---

function refuse(io, message) {
  io.stderr.write(`${message}\n`);
  return 2;
}

function leftLines({ provider, dataDir, defaultDir }) {
  const dirFlag = dataDir === defaultDir ? '' : ` --data-dir "${dataDir}"`;
  return [
    'What is left, in order:',
    `  1. king-louie-service token set ${provider ? shown(provider) : '<provider>'}${dirFlag}   (the delegate's provider key, read from stdin, with the service stopped)`,
    `  2. king-louie-service pair wss://<relay>${dirFlag}   or   pair https://mcp.<domain>${dirFlag}   (a relay or a front door: writes the pin and starts the node)`,
    `  3. king-louie-service enroll-device${dirFlag}   (your phone; needs the node running)`,
    `  4. king-louie-service vault set browser_cred:<profile>:<host>${dirFlag}   (one for each login the takes will use, read from stdin)`,
    `  5. king-louie-service mcp${dirFlag}   (the command for the driver's MCP client config)`
  ];
}

async function install({ flags, io, c }) {
  // Off a terminal nobody can be asked, so only --yes goes on; checked
  // before anything is read.
  if (!flags.dryRun && !flags.yes && !c.isTTY()) {
    return refuse(io, 'Refusing to install the personal node without confirmation on a non-interactive terminal; pass --yes.');
  }
  // Files an elevated prompt made would be Administrators-owned, and the
  // start's owner check (§6) would then refuse them.
  if (c.isAdmin()) return refuse(io, 'install --personal runs as you, not elevated: open a normal prompt');
  const fleet = c.fleetInstalled() || {};
  if (fleet.task || fleet.marker) return refuse(io, fleetRefusal(fleet));
  if (!flags.dataDir) return refuse(io, 'LOCALAPPDATA is not set, so there is no default data dir: pass --data-dir DIR');

  const dataDir = path.resolve(flags.dataDir);
  // adminConfigDir's Windows rule (config beside the data dir), in the
  // running platform's path form so the files land where it says.
  const configDir = path.join(path.dirname(dataDir), 'config');
  const yamlPath = path.join(configDir, NODE_YAML);

  const chrome = flags.browser || c.findChrome();
  if (!chrome) return refuse(io, 'no chrome.exe found; pass --browser <path>');
  const wanted = { name: c.hostname(), chrome, provider: flags.provider, model: flags.model };
  const yaml = renderNodeYaml(wanted);
  try {
    parseGuiConfig(parseYaml(yaml).gui, { profile: 'agent', platform: 'win32' });
  } catch {
    return refuse(io, `--browser ${shown(chrome)} is not an absolute path to an .exe`);
  }

  const account = c.whoAmI();
  const existing = readYaml(yamlPath);
  if (existing && existing.error) return refuse(io, `Could not read ${yamlPath}: ${existing.error.message}`);
  const missing = existing ? missingLines(existing.text, wantedLeaves(wanted)) : null;
  // The task is started only when the node.yaml it will run is one that
  // starts: a fresh one has no relay yet, and pair starts it.
  const start = existing ? c.startable(configDir) : { ok: false, why: NOTHING_PAIRED };
  const relay = start.ok;
  // A fleet data dir with no node.yaml beside it is a leftover that the
  // default data dir rule ignores (paths.js defaultServiceDataDir).
  const fleetData = require('../platform/paths').fleetDataDir({ platform: 'win32', env: c.env });
  const leftover = path.resolve(fleetData) !== dataDir && c.exists(fleetData);

  io.stdout.write([
    'install --personal will set up a King Louie personal node:',
    `  account:    ${shown(account.user)} (${shown(account.sid)})`,
    `  data dir:   ${dataDir}`,
    `  config dir: ${configDir}`,
    `  logon task: ${PERSONAL_TASK_NAME}`,
    `  ${TRUST_LINE}`,
    `  ${REBOOT_LINE}`,
    'It will write:',
    existing ? `  ${yamlPath} (exists: install keeps it)` : `  ${yamlPath}`,
    `  ${dataDir} and ${configDir} (created when missing)`,
    `  the logon task "${PERSONAL_TASK_NAME}" (registered again when it exists)`,
    ''
  ].join('\n'));
  if (!existing) {
    io.stdout.write(`${NODE_YAML}:\n${yaml}`);
  } else if (missing === null) {
    io.stdout.write(`${yamlPath} exists and install keeps it; it could not be parsed, so compare it with:\n${yaml}`);
  } else if (missing.length) {
    io.stdout.write(`${yamlPath} exists and install keeps it; it lacks these lines (add them yourself):\n${missing.map((l) => `  ${l}\n`).join('')}`);
  } else {
    io.stdout.write(`${yamlPath} exists and install keeps it; it has every line install would write.\n`);
  }
  // A warning, not a refusal: a take that records refuses recorder_missing
  // later with the same remedy.
  if (!c.findFfmpeg()) io.stdout.write(`${FFMPEG_LINE}\n`);
  if (leftover) io.stdout.write(`${fleetData} exists but no fleet config file is beside it: every command ignores it, and it may be removed.\n`);

  const xmlPath = path.join(c.tmpDir, `king-louie-node-${crypto.randomBytes(6).toString('hex')}.xml`);
  const schtasks = windowsSchtasksExe(c.env);
  const steps = [
    { description: 'write the logon task definition', writeFile: { path: xmlPath, content: `\ufeff${renderPersonalTaskXml({ sid: account.sid, nodePath: c.nodePath, entryPath: c.entryPath, dataDir, env: c.env })}`, mode: 0o600, encoding: 'utf16le' } },
    { description: `register the logon task "${PERSONAL_TASK_NAME}"`, run: [schtasks, '/Create', '/TN', PERSONAL_TASK_NAME, '/XML', xmlPath, '/F'] },
    { description: 'delete the temporary task definition', unlink: xmlPath, always: true, ignoreFailure: true }
  ];
  if (relay) steps.push({ description: `start the logon task "${PERSONAL_TASK_NAME}"`, run: [schtasks, '/Run', '/TN', PERSONAL_TASK_NAME] });

  if (flags.dryRun) {
    await executeSteps(steps, { dryRun: true, io });
    return 0;
  }
  if (!flags.yes && (await c.confirm('Install the personal node? [y/N] ')) !== true) {
    io.stderr.write('Not installing without confirmation. Nothing was written.\n');
    return 1;
  }

  ensurePrivateDir(dataDir);
  ensurePrivateDir(configDir);
  if (!existing) {
    fs.writeFileSync(yamlPath, yaml, { mode: 0o600, flag: 'wx' });
    io.stdout.write(`wrote ${yamlPath}\n`);
  }
  await c.execute(steps);
  io.stdout.write(relay
    ? `The logon task "${PERSONAL_TASK_NAME}" is registered and started.\n`
    : `The logon task "${PERSONAL_TASK_NAME}" is registered and not started: ${start.why}.\n`);
  // Whether --data-dir must be spelled out is what the CLI would pick now
  // that the data dir exists.
  const defaultDir = require('../platform/paths').defaultServiceDataDir({ platform: 'win32', env: c.env, exists: c.exists });
  io.stdout.write(`${leftLines({ provider: flags.provider, dataDir, defaultDir }).join('\n')}\n`);
  return 0;
}

async function uninstall({ flags, io, c }) {
  if (!flags.dryRun && !flags.yes && !c.isTTY()) {
    return refuse(io, 'Refusing to remove the personal node\'s logon task without confirmation on a non-interactive terminal; pass --yes.');
  }
  if (!c.taskRegistered()) {
    io.stdout.write(`The logon task "${PERSONAL_TASK_NAME}" is not registered: nothing to remove. The data dir stays as it is.\n`);
    return 0;
  }
  const schtasks = windowsSchtasksExe(c.env);
  const steps = [
    // Already stopped (or never started) is not a reason to stop here.
    { description: `stop the logon task "${PERSONAL_TASK_NAME}"`, run: [schtasks, '/End', '/TN', PERSONAL_TASK_NAME], ignoreFailure: true },
    { description: `delete the logon task "${PERSONAL_TASK_NAME}"`, run: [schtasks, '/Delete', '/TN', PERSONAL_TASK_NAME, '/F'] }
  ];
  const stays = flags.dataDir
    ? `The data dir ${path.resolve(flags.dataDir)} stays, and so does the config dir beside it: the node's identity, chats and vault are in them. Delete them yourself to remove the node.`
    : 'The data dir stays: the node\'s identity, chats and vault are in it.';
  if (flags.dryRun) {
    await executeSteps(steps, { dryRun: true, io });
    io.stdout.write(`${stays}\n`);
    return 0;
  }
  if (!flags.yes && (await c.confirm(`Remove the logon task "${PERSONAL_TASK_NAME}"? [y/N] `)) !== true) {
    io.stderr.write('Not removing without confirmation. Nothing was removed.\n');
    return 1;
  }
  await c.execute(steps);
  io.stdout.write(`${stays}\n`);
  return 0;
}

async function runPersonalInstall({ command, flags = {}, io, deps = {} }) {
  const c = resolveDeps(deps, io);
  if (c.platform !== 'win32') return refuse(io, `${command} --personal is Windows-only for now`);
  if (command === 'install') return install({ flags, io, c });
  if (command === 'uninstall') return uninstall({ flags, io, c });
  return refuse(io, `Unknown command "${command}".`);
}

module.exports = { runPersonalInstall, renderPersonalTaskXml, renderNodeYaml, PERSONAL_TASK_NAME };
