'use strict';
// LongHaul's CLI (benchmark spec §3). Each command is
// { needsHome?, options (node:util parseArgs), run(ctx, values, positionals) }
// and returns an exit code: 0 success, 1 failure, 2 usage or refusal.
const { parseArgs } = require('node:util');
const { resolveHome, ensureDirs } = require('./home');
const { UsageError } = require('./errors');

const COMMANDS = {
  home: require('./commands/home'),
  import: require('./commands/import'),
  synth: require('./commands/synth')
};

function usage() {
  return [
    'Usage: longhaul <command> [options]',
    '',
    `Commands: ${Object.keys(COMMANDS).sort().join(', ')}`,
    'Data lives in LONGHAUL_HOME (default ~/.longhaul), never inside a git working tree.',
    ''
  ].join('\n');
}

function isUsageProblem(err) {
  return err instanceof UsageError || String(err?.code || '').startsWith('ERR_PARSE_ARGS');
}

async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    stdout.write(usage());
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    stderr.write(`Unknown command "${name}".\n${usage()}`);
    return 2;
  }
  try {
    const { values, positionals } = parseArgs({ args: rest, options: command.options || {}, allowPositionals: true, strict: true });
    const home = command.needsHome === false ? null : ensureDirs(resolveHome(env, { homedir: io.homedir }));
    const ctx = {
      home, env, stdout, stderr,
      stdin: io.stdin || process.stdin,
      now: io.now || (() => new Date()),
      cwd: io.cwd || process.cwd()
    };
    return await command.run(ctx, values, positionals);
  } catch (err) {
    if (isUsageProblem(err)) {
      stderr.write(`${err.message}\n`);
      return 2;
    }
    stderr.write(`longhaul ${name} failed: ${err.message}\n`);
    return 1;
  }
}

module.exports = { main, COMMANDS, usage };
