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
      if (eq !== -1) {
        throw new Error('Flag "--dry-run" does not take a value.');
      }
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
    // Applies to both "--flag value" and "--flag=value": a missing value or
    // one that looks like another flag is always an error, whichever form
    // produced it.
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Flag "--${rawName}" requires a value.`);
    }
    if (value === '') {
      throw new Error(`Flag "--${rawName}" must not be empty.`);
    }
    flags[camelName] = value;
  }
  return { positional, flags };
}

// Buffers are concatenated and decoded once, so a multi-byte UTF-8 character
// split across two chunks survives intact.
async function readStdin(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
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
        // A running service holds its own in-memory copy of the stores and
        // would overwrite this change on its next write.
        const { readPidfile, isRunning } = require('./pidfile');
        const pid = readPidfile(dataDir);
        if (pid && isRunning(pid)) {
          io.stderr.write(`The service is running (pid ${pid}) on ${dataDir}. Stop it first, run this again, then start it.\n`);
          return 1;
        }
        const { createCore, PROVIDER_LABELS } = require('../core');
        let name = arg;
        if (command === 'token') {
          name = arg.trim().toLowerCase();
          if (!Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, name)) {
            io.stderr.write(`Unknown provider "${arg}". Known providers: ${Object.keys(PROVIDER_LABELS).join(', ')}\n`);
            return 2;
          }
        }
        const value = await readStdin(io.stdin);
        if (!value.trim()) { io.stderr.write('No value on stdin.\n'); return 2; }
        const { CHAT_DATA_DEFAULTS } = require('../core/settings');
        const { buildServicePorts } = require('./ports');
        const { restoreDataDirOwnership } = require('./ownership');
        // Every path the ports create or write this run, reported as it
        // happens so a failure partway through still hands back what it
        // managed to write. Nothing else in the data dir is touched.
        const writtenPaths = [];
        try {
          const core = createCore(buildServicePorts({
            dataDir,
            chatDataDefaults: CHAT_DATA_DEFAULTS,
            onPathWritten: (p) => writtenPaths.push(p)
          }));
          if (command === 'token') core.saveProviderToken(name, value);
          else core.vault.set(name, value);
        } finally {
          // Run as root, everything written above is root-owned; hand it back
          // to the service account that owns the data dir.
          restoreDataDirOwnership(dataDir, writtenPaths, io.ownership);
        }
        io.stdout.write(`${command === 'token' ? 'Token' : 'Secret'} "${name}" saved (encrypted).\n`);
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
