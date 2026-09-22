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

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a.startsWith('--')) {
      const name = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      flags[name] = argv[i + 1];
      i += 1;
    } else positional.push(a);
  }
  return { positional, flags };
}

async function readStdin(stdin) {
  let text = '';
  for await (const chunk of stdin) text += chunk;
  return text.replace(/\r?\n$/, '');
}

async function main(argv, io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }) {
  const { positional, flags } = parseArgs(argv);
  const [command, sub, arg] = positional;
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
