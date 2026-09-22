// CLI output goes to stdout/stderr on purpose; everything else logs via createLogger.
const { defaultServiceDataDir } = require('../platform/paths');

const HELP = `Usage:
  king-louie-service run [--data-dir DIR] [--profile agent|runbook]
  king-louie-service status [--data-dir DIR]
  king-louie-service doctor [--data-dir DIR]
  king-louie-service token set <provider> [--data-dir DIR]     (value read from stdin)
  king-louie-service vault set <key> [--data-dir DIR]          (value read from stdin)
  king-louie-service install [--profile P] [--user NAME] [--data-dir DIR] [--dry-run]
  king-louie-service uninstall [--dry-run]
`;

const VALUE_FLAGS = new Set(['data-dir', 'profile', 'user']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const rawName = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (rawName === 'dry-run') {
      flags.dryRun = true;
      continue;
    }
    if (!VALUE_FLAGS.has(rawName)) {
      throw new Error(`Unknown flag "--${rawName}".`);
    }
    const camelName = rawName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    let value;
    if (eq !== -1) {
      value = a.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i += 1;
      }
    }
    if (value === undefined) {
      throw new Error(`Flag "--${rawName}" requires a value.`);
    }
    if (rawName === 'data-dir' && value === '') {
      throw new Error('Flag "--data-dir" must not be empty.');
    }
    flags[camelName] = value;
  }
  return { positional, flags };
}

async function readStdin(stdin) {
  let text = '';
  for await (const chunk of stdin) text += chunk;
  return text.replace(/\r?\n$/, '');
}

async function main(argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  let positional;
  let flags;
  try {
    ({ positional, flags } = parseArgs(argv));
  } catch (err) {
    io.stderr.write(`${err.message}\n${HELP}`);
    return 2;
  }
  const [command, sub, arg] = positional;
  // flags.dataDir is only ever undefined (flag absent) or a validated
  // non-empty string here — parseArgs rejects a missing or empty --data-dir
  // above, so the default is used only when the flag was never given.
  const dataDir = flags.dataDir || defaultServiceDataDir();

  try {
    switch (command) {
      case undefined:
      case 'help':
        io.stdout.write(HELP);
        return 0;

      case 'run': {
        const { runService } = require('./run');
        await runService({ dataDir, profile: flags.profile, stdout: io.stdout });
        return 0;
      }

      case 'status': {
        const { readPidfile, isRunning } = require('./pidfile');
        const pid = readPidfile(dataDir);
        if (pid && isRunning(pid)) {
          io.stdout.write(`running (pid ${pid}) — data dir ${dataDir}\n`);
          return 0;
        }
        io.stdout.write(`not running — data dir ${dataDir}\n`);
        return 3;
      }

      case 'doctor': {
        const { runDoctor } = require('./doctor');
        const results = runDoctor({ dataDir });
        for (const r of results) io.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.check}  (${r.detail})\n`);
        return results.every((r) => r.ok) ? 0 : 1;
      }

      case 'token':
      case 'vault': {
        if (sub !== 'set' || !arg) {
          io.stderr.write(`Usage: king-louie-service ${command} set <${command === 'token' ? 'provider' : 'key'}>\n`);
          return 2;
        }
        const value = await readStdin(io.stdin);
        if (!value) { io.stderr.write('No value on stdin.\n'); return 2; }
        const { createCore } = require('../core');
        const { CHAT_DATA_DEFAULTS } = require('../core/settings');
        const { buildServicePorts } = require('./ports');
        const core = createCore(buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS }));
        if (command === 'token') core.saveProviderToken(arg, value);
        else core.vault.set(arg, value);
        io.stdout.write(`${command === 'token' ? 'Token' : 'Secret'} "${arg}" saved (encrypted).\n`);
        return 0;
      }

      case 'install':
      case 'uninstall': {
        const { runInstallCommand } = require('./installers');
        return await runInstallCommand(command, { ...flags, dataDir }, io);
      }

      default:
        io.stderr.write(`Unknown command "${command}".\n${HELP}`);
        return 2;
    }
  } catch (err) {
    io.stderr.write(`Error: ${err.message}\n`);
    return 1;
  }
}

module.exports = { main, parseArgs };
