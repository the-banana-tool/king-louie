// CLI output goes to stdout/stderr on purpose; everything else logs via createLogger.
const { defaultServiceDataDir } = require('../platform/paths');

const HELP = `Usage:
  king-louie-service run [--data-dir DIR] [--profile agent|runbook]
  king-louie-service status [--data-dir DIR]
  king-louie-service doctor [--data-dir DIR]
  king-louie-service mcp [--data-dir DIR]
  king-louie-service pair <front-door-url> [--data-dir DIR]
  king-louie-service token set <provider> [--data-dir DIR]     (value read from stdin)
  king-louie-service vault set <key> [--data-dir DIR]          (value read from stdin)
  king-louie-service channel list <channel> [--data-dir DIR]
  king-louie-service channel allow <channel> <id> [--group] [--data-dir DIR]
  king-louie-service channel remove <channel> <id> [--group] [--data-dir DIR]
  king-louie-service channel approval <channel> (<chat-id> | --clear) [--data-dir DIR]
  king-louie-service install [--profile P] [--user NAME] [--data-dir DIR] [--dry-run]
  king-louie-service uninstall [--dry-run]

A chat channel with an empty allowlist refuses every sender, and a channel
approval is denied unless "channel approval" names an owner chat that is not
the chat the request came from.
`;

const CHANNEL_HELP = `Usage: king-louie-service channel list <channel> [--data-dir DIR]
       king-louie-service channel allow <channel> <id> [--group] [--data-dir DIR]
       king-louie-service channel remove <channel> <id> [--group] [--data-dir DIR]
       king-louie-service channel approval <channel> (<chat-id> | --clear) [--data-dir DIR]
`;

const VALUE_FLAGS = new Set(['data-dir', 'profile', 'user']);
// Flags that must never carry a value, whichever form produced it.
const BOOLEAN_FLAGS = new Set(['dry-run', 'group', 'clear']);

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
    const toCamel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (BOOLEAN_FLAGS.has(rawName)) {
      if (eq !== -1) {
        throw new Error(`Flag "--${rawName}" does not take a value.`);
      }
      flags[toCamel(rawName)] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(rawName)) {
      throw new Error(`Unknown flag "--${rawName}".`);
    }
    const camelName = toCamel(rawName);
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

// The MCP stdio transport owns stdout: one stray line there and the client
// sees a corrupt message. The logger writes info and debug through
// console.log/console.debug, which go to stdout, so for the life of `mcp`
// every console method that would reach stdout writes to stderr instead.
// Returns a function that puts the originals back.
function routeConsoleToStderr(stderr) {
  const util = require('util');
  const methods = ['log', 'info', 'debug'];
  const originals = Object.fromEntries(methods.map((m) => [m, console[m]]));
  const toStderr = (...args) => { stderr.write(`${util.format(...args)}\n`); };
  for (const m of methods) console[m] = toStderr;
  return () => { for (const m of methods) console[m] = originals[m]; };
}

// Slack is absent on purpose: SlackChannel has no allowlist check yet, so
// offering to configure one would claim a gate that does not exist.
const KNOWN_CHANNELS = ['telegram', 'discord'];

// The pid of a service running on this data dir, or null. A running service
// holds its own in-memory copy of the stores and would overwrite anything
// the CLI writes underneath it.
function runningServicePid(dataDir) {
  const { readPidfile, isRunning } = require('./pidfile');
  const pid = readPidfile(dataDir);
  return pid && isRunning(pid) ? pid : null;
}

// Opens the service's stores and runs `fn(core, ports)` against them. The
// ports go along because the core does not expose its cipher. Every path the ports create or write is reported as it happens, so a
// failure partway through still hands back what it managed to write: run as
// root, everything written here is root-owned and has to go back to the
// service account that owns the data dir. Nothing else in the data dir is
// touched.
function withServiceCore(dataDir, io, fn) {
  const { createCore } = require('../core');
  const { CHAT_DATA_DEFAULTS } = require('../core/settings');
  const { buildServicePorts } = require('./ports');
  const { restoreDataDirOwnership } = require('./ownership');
  const writtenPaths = [];
  try {
    const ports = buildServicePorts({
      dataDir,
      chatDataDefaults: CHAT_DATA_DEFAULTS,
      onPathWritten: (p) => writtenPaths.push(p)
    });
    const core = createCore(ports);
    return fn(core, ports);
  } finally {
    restoreDataDirOwnership(dataDir, writtenPaths, io.ownership);
  }
}

function formatChannelAccess(channel, policy, approvalChatId) {
  const block = (label, ids) => `${label}:\n${ids.length ? ids.map((id) => `  ${id}`).join('\n') : '  (none)'}\n`;
  return `${channel} — default: ${policy.default}\n`
    + block('users', policy.users)
    + block('groups', policy.groups)
    + `approvals: ${approvalChatId ? approvalChatId : 'denied (no approval target set)'}\n`;
}

async function runChannelCommand({ sub, channelArg, idArg, flags, dataDir, io }) {
  const actions = new Set(['list', 'allow', 'remove', 'approval']);
  if (!actions.has(sub) || !channelArg) {
    io.stderr.write(CHANNEL_HELP);
    return 2;
  }
  const channel = String(channelArg).trim().toLowerCase();
  if (!KNOWN_CHANNELS.includes(channel)) {
    io.stderr.write(`Unknown channel "${channelArg}". Known channels: ${KNOWN_CHANNELS.join(', ')}\n`);
    return 2;
  }

  const id = idArg === undefined ? '' : String(idArg).trim();
  if ((sub === 'allow' || sub === 'remove') && !id) {
    io.stderr.write(CHANNEL_HELP);
    return 2;
  }
  if (sub === 'approval') {
    // An id and --clear both say what to do; neither does not.
    if (flags.clear && id) {
      io.stderr.write('Give either a chat id or --clear, not both.\n');
      return 2;
    }
    if (!flags.clear && !id) {
      io.stderr.write(CHANNEL_HELP);
      return 2;
    }
  }

  if (sub !== 'list') {
    const pid = runningServicePid(dataDir);
    if (pid) {
      io.stderr.write(`The service is running (pid ${pid}) on ${dataDir}. Stop it first, run this again, then start it.\n`);
      return 1;
    }
  }

  const AllowlistManager = require('../channels/allowlist-manager');
  return withServiceCore(dataDir, io, (core) => {
    const manager = new AllowlistManager(core.context.getStore());
    const readApproval = () => {
      const value = core.getSettings().channels?.[channel]?.approvalChatId;
      return String(value == null ? '' : value).trim();
    };

    if (sub === 'approval') {
      const approvalChatId = flags.clear ? '' : id;
      const settings = core.getSettings();
      core.context.setSettings({
        ...settings,
        channels: {
          ...(settings.channels || {}),
          [channel]: { ...(settings.channels?.[channel] || {}), approvalChatId }
        }
      });
      io.stdout.write(approvalChatId
        ? `${channel} approvals will be sent to ${approvalChatId}.\n`
        : `${channel} approval target cleared — every ${channel} approval is now denied.\n`);
      return 0;
    }

    // `allow` and `remove` touch one id; nothing here can set default: allow,
    // so an unconfigured channel stays closed to everyone else.
    if (sub === 'allow') {
      if (flags.group) manager.addGroup(channel, id);
      else manager.addUser(channel, id);
    } else if (sub === 'remove') {
      if (flags.group) manager.removeGroup(channel, id);
      else manager.removeUser(channel, id);
    }

    io.stdout.write(formatChannelAccess(channel, manager.getPolicy(channel), readApproval()));
    return 0;
  });
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
  const [command, sub, arg, arg2] = positional;
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

      case 'mcp': {
        // Before anything that could log, so nothing reaches the protocol
        // stream on stdout. Left in place once the server is up, since the
        // command runs until the process exits; undone if startup fails.
        const restoreConsole = routeConsoleToStderr(io.stderr);
        try {
          return withServiceCore(dataDir, io, (core) => {
            const { loadNodeConfig } = require('./node-config');
            const { RunbookEngine } = require('../runbooks/runbook-engine');
            const StdioMcpServer = require('../mcp/stdio-server');

            const nodeCfg = loadNodeConfig({ dataDir });

            const runbookEngine = new RunbookEngine({
              runbooksDir: nodeCfg.runbooksDir,
              allowedRoots: nodeCfg.policy.allowed_roots
            });
            // Loaded once, here: a bad runbook file fails the command at
            // startup with its error on stderr, instead of the server coming
            // up with a catalog that is silently empty.
            runbookEngine.loadRunbooks();

            const server = new StdioMcpServer({
              nodeConfig: nodeCfg,
              runbookEngine,
              stdin: io.stdin,
              stdout: io.stdout
            });

            server.start();
            return new Promise(() => {}); // keep listening on stdio
          });
        } catch (err) {
          restoreConsole();
          throw err;
        }
      }

      case 'pair': {
        // The URL is the first word after the command, i.e. `sub` here.
        const frontDoorUrl = sub;
        if (!frontDoorUrl) {
          io.stderr.write('Usage: king-louie-service pair <front-door-url> [--data-dir DIR]\n');
          return 2;
        }
        // Creating the identity writes to the service's store, which a
        // running service would overwrite from its own in-memory copy.
        const pid = runningServicePid(dataDir);
        if (pid) {
          io.stderr.write(`The service is running (pid ${pid}) on ${dataDir}. Stop it first, run this again, then start it.\n`);
          return 1;
        }
        return withServiceCore(dataDir, io, (core, ports) => {
          const { loadNodeConfig } = require('./node-config');
          const { getOrGenerateNodeIdentity } = require('../mesh/node-identity');
          const nodeCfg = loadNodeConfig({ dataDir });
          const identity = getOrGenerateNodeIdentity(core.context.getStore(), ports.cipher, nodeCfg.name);

          // What §5.1 step 1 shows the owner. The exchange that follows
          // (one-time code, key pinning) needs a front door to talk to,
          // which is built in stage 4, so this stops here and says so
          // rather than asking for a code nothing would check.
          io.stdout.write(`Node Name: ${nodeCfg.name}\n`);
          io.stdout.write(`Node ID: ${identity.nodeId}\n`);
          io.stdout.write(`TLS Fingerprint: ${identity.tlsFingerprint}\n`);
          io.stderr.write(`Pairing with a front door is not available yet: the front door is built in stage 4. Nothing was sent to ${frontDoorUrl}.\n`);
          return 1;
        });
      }

      case 'channel':
        return await runChannelCommand({ sub, channelArg: arg, idArg: arg2, flags, dataDir, io });

      case 'token':
      case 'vault': {
        if (sub !== 'set' || !arg) {
          io.stderr.write(`Usage: king-louie-service ${command} set <${command === 'token' ? 'provider' : 'key'}>\n`);
          return 2;
        }
        // A running service holds its own in-memory copy of the stores and
        // would overwrite this change on its next write.
        const pid = runningServicePid(dataDir);
        if (pid) {
          io.stderr.write(`The service is running (pid ${pid}) on ${dataDir}. Stop it first, run this again, then start it.\n`);
          return 1;
        }
        const { PROVIDER_LABELS } = require('../core');
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
        withServiceCore(dataDir, io, (core) => {
          if (command === 'token') core.saveProviderToken(name, value);
          else core.vault.set(name, value);
        });
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
