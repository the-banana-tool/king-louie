// src/service/commands/identity.js
// `king-louie-service identity …` (owner ruling R-F5-17). CLI output goes to
// io.stdout/io.stderr on purpose; everything else logs via createLogger.
//   identity record [--replace]  (elevated) write the administrator's record
//                                of this node's identity into the config dir
//   identity show                print that record
// `record` is the only thing that writes the record. Like "desktop pair" and
// "session install" it shows what it is about to vouch for first (the node's
// name, id and fingerprint), then asks [y/N]; off a terminal it needs --yes
// (exit 2, before anything is read); nothing is written before the answer.
const IDENTITY_USAGE = `Usage: king-louie-service identity record [--replace] [--data-dir DIR] [--dry-run] [--yes]
       king-louie-service identity show [--data-dir DIR]
`;

function common(dataDir, deps, io) {
  const { adminConfigDir } = require('../../platform/paths');
  const platform = deps.platform || process.platform;
  const configDir = deps.configDir || adminConfigDir({ platform, dataDir });
  const adminOptions = {
    ...(deps.adminUid === undefined ? {} : { adminUid: deps.adminUid }),
    ...(deps.geteuid ? { geteuid: deps.geteuid } : {})
  };
  return {
    platform,
    configDir,
    isTTY: deps.isTTY || (() => Boolean(io && io.stdin && io.stdin.isTTY)),
    confirm: deps.confirm || ((question) => require('./desktop').defaultConfirm(io, question)),
    isAdmin: deps.isAdmin || (() => require('./admin-check').isAdmin({ platform })),
    // node.yaml is the admin's; a file that fails its owner check throws.
    nodeName: deps.nodeName || (() => require('../node-config').loadNodeConfig({ dataDir, adminConfigDir: configDir, ...adminOptions }).name),
    // The admin's own reading of the record: no service-side write probe.
    recordOptions: { configDir, platform, serviceProbe: false, ...(deps.adminUid === undefined ? {} : { adminUid: deps.adminUid }), ...(deps.identityRecord || {}) }
  };
}

const idText = (nodeId) => `${nodeId} (fingerprint ${require('../../approvals/envelope').fingerprintGroups(nodeId)})`;

async function record({ flags, dataDir, io, deps }) {
  const R = require('../identity-record');
  const c = common(dataDir, deps, io);
  if (!c.isAdmin()) { io.stderr.write('identity record needs root (or an elevated Administrator prompt on Windows).\n'); return 1; }
  // Off a terminal nobody can be asked, so only --yes goes on. Checked
  // before anything is resolved or read.
  if (!flags.dryRun && !flags.yes && !c.isTTY()) {
    io.stderr.write('Refusing to record the node identity without confirmation on a non-interactive terminal; pass --yes.\n');
    return 2;
  }
  // Everything from here to the question only reads. The identity is the
  // one the data dir holds, verified as "session install" verifies it: its
  // public key is its private key's, and the private key is held under this
  // data dir's master key (never in the clear).
  const { resolveNodeIdentity, verifyWindowsConfigDir } = require('./session');
  const { nodeId, publicKey } = resolveNodeIdentity({ dataDir, platform: c.platform, deps, nothing: 'nothing was recorded' });
  const file = R.recordPath(c.configDir);
  const existing = R.readIdentityRecord(c.recordOptions);
  if (existing.state === 'recorded' && existing.publicKey === publicKey) {
    io.stdout.write(`Node identity ${idText(nodeId)} is already recorded in ${file} (${existing.recordedAt}). Nothing to do.\n`);
    return 0;
  }
  if (existing.state !== 'none' && !flags.replace) {
    if (existing.state === 'recorded') {
      io.stderr.write(`${file} records another identity, ${idText(existing.nodeId)}, not the one in ${dataDir}, ${idText(nodeId)}.\n`
        + 'If the data dir was replaced or reset on purpose, run this again with --replace (phones, relays and desktops paired with the old identity must be paired again). '
        + 'If it was not, something else changed the data dir: restore it from a backup.\nNothing was written.\n');
    } else {
      io.stderr.write(`${file} ${existing.reason}, so it does not say which identity was recorded.\n`
        + 'Find out who could have changed it, then run this again with --replace to write it anew.\nNothing was written.\n');
    }
    return 1;
  }
  if (flags.dryRun) {
    io.stdout.write(`[dry-run] write ${file} (node ${nodeId})\n`);
    return 0;
  }

  // What is about to be vouched for, then the question. Nothing has been
  // created or written yet.
  io.stdout.write(`Node "${require('./io').shown(c.nodeName(), 64)}": ${idText(nodeId)}\n`);
  io.stdout.write(`  read from: ${dataDir} (its private key is held under that data dir's master key)\n`);
  io.stdout.write(`  records: this id and its public key in ${file}, which only an administrator can change\n`);
  io.stdout.write('  from then on: the service refuses to start, and "session install" refuses, while the data dir holds any other identity\n');
  if (existing.state === 'recorded') {
    io.stdout.write(`  replaces: the record of ${idText(existing.nodeId)}; phones, relays and desktops paired with that identity must be paired again\n`);
  } else if (existing.state === 'invalid') {
    io.stdout.write(`  replaces: a record that could not be used (${file} ${existing.reason})\n`);
  }
  io.stdout.write('Compare the id with the one your phones show for this node (and the one "king-louie-service pair" printed) before you answer.\n');
  const yes = flags.yes ? true : (await c.confirm('Record this identity for the node? [y/N] ')) === true;
  if (!yes) {
    io.stderr.write('Not recording without confirmation. Nothing was written.\n');
    return 1;
  }

  // Windows: the config dir the record goes into must be the administrators'
  // (owner and ACL, no link or foreign owner above it): the installers' own
  // create-or-verify check. After consent, because it creates the directory
  // when it is missing.
  if (c.platform === 'win32') {
    try {
      (deps.verifyConfigDir || verifyWindowsConfigDir)(c.configDir);
    } catch (err) {
      io.stderr.write(`${String(err.message).replace(/[\s.]+$/, '')}. Nothing was written.\n`);
      return 1;
    }
  }
  R.writeIdentityRecord({ configDir: c.configDir, nodeId, publicKey, platform: c.platform, ...(deps.runIcacls ? { runIcacls: deps.runIcacls } : {}) });
  // Read back the way the readers will: a record that would be refused is
  // said now, not at the next start.
  const written = R.readIdentityRecord(c.recordOptions);
  if (written.state !== 'recorded' || written.publicKey !== publicKey) {
    io.stderr.write(`${file} was written but does not verify: it ${written.state === 'invalid' ? written.reason : 'does not hold this identity'}. The service will refuse it; fix the owner or the permissions of ${c.configDir} and run this again with --replace.\n`);
    return 1;
  }
  io.stdout.write(`Recorded. ${file} now names ${nodeId}.\n`);
  io.stdout.write('A running service checked the record when it started: restart it so that it reads this one.\n');
  return 0;
}

async function show({ dataDir, io, deps }) {
  const R = require('../identity-record');
  const c = common(dataDir, deps, io);
  const seen = R.readIdentityRecord(c.recordOptions);
  if (seen.state === 'recorded') {
    io.stdout.write(`${idText(seen.nodeId)}\n  recorded: ${seen.recordedAt}\n  file: ${seen.file}\n`);
    return 0;
  }
  if (seen.state === 'none') {
    io.stdout.write(`No administrator record of this node's identity (${seen.file} is missing). As root or an Administrator run "king-louie-service identity record".\n`);
    return 1;
  }
  io.stderr.write(`${seen.file} ${seen.reason}.\n`);
  return 1;
}

async function runIdentityCommand({ sub, flags = {}, dataDir, io, deps = {} }) {
  try {
    switch (sub) {
      case 'record': return await record({ flags, dataDir, io, deps });
      case 'show': return await show({ dataDir, io, deps });
      default:
        io.stderr.write(IDENTITY_USAGE);
        return 2;
    }
  } catch (err) {
    io.stderr.write(`Error: ${err.message}\n`);
    return 1;
  }
}

module.exports = { runIdentityCommand, IDENTITY_USAGE };
