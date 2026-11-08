// `king-louie-service features set remoteWindow on|off [--data-dir DIR]` (R-RW-20).
// Rewrites that key of `features` in <configDir>/service.json and keeps every other.
// Only that one: the rest open listeners, and an administrator sets them by hand.
// The service reads that file once at start, so it refuses while the node runs.
const fs = require('fs');
const path = require('path');
const { adminConfigDir } = require('../../platform/paths');
const { DEFAULT_FEATURES } = require('../config');
const { stopFirstText } = require('./stop');
const { isAdmin: defaultIsAdmin } = require('./admin-check');
const { writeKeepingOwnership, readHosting } = require('./desktop');

const NAME = 'remoteWindow';
const USAGE = `Usage: king-louie-service features set ${NAME} on|off [--data-dir DIR]\n`;
const VALUES = { on: true, off: false };

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The file as an object, {} when there is none yet (a personal node may have none),
// or null when what is there cannot be kept.
function readServiceFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    if (isPlainObject(parsed) && (parsed.features === undefined || isPlainObject(parsed.features))) return parsed;
  } catch {
    // Said below, for this and the wrong shape alike.
  }
  return null;
}

async function runFeaturesCommand({ sub, arg, arg2, dataDir, io, deps = {} }) {
  if (sub !== 'set' || arg !== NAME || !Object.hasOwn(VALUES, String(arg2))) {
    if (sub === 'set' && arg !== undefined && arg !== NAME) io.stderr.write(`This command does not set "${arg}".\n`);
    io.stderr.write(USAGE);
    return 2;
  }
  const pid = deps.runningServicePid ? deps.runningServicePid(dataDir) : require('./io').runningServicePid(dataDir);
  if (pid) {
    io.stderr.write(`${stopFirstText(pid, dataDir)}\n`);
    return 1;
  }
  const configDir = deps.configDir || adminConfigDir({ dataDir });
  // As `desktop pair`: an elevated run would leave a file the owner's node cannot trust.
  if (!fs.existsSync(configDir)) {
    io.stderr.write(`${configDir} does not exist: install the node first. Nothing was written.\n`);
    return 1;
  }
  // A node.yaml that will not load cannot say this is not a personal node.
  const { hosting, error: nodeConfigError } = readHosting({ dataDir, configDir, deps });
  if (nodeConfigError) {
    io.stderr.write(`node.yaml does not load, so this cannot tell how the node is hosted: ${nodeConfigError.message}. Nothing was written.\n`);
    return 1;
  }
  if (hosting === 'personal' && await (deps.isAdmin || defaultIsAdmin)()) {
    io.stderr.write('features set on a personal node runs as you, not elevated: open a normal prompt.\n');
    return 1;
  }
  const file = path.join(configDir, 'service.json');
  let service;
  try {
    service = readServiceFile(file);
  } catch (err) {
    io.stderr.write(`Cannot read ${file} (${err.code || 'unknown'}): run this as the account that owns it.\n`);
    return 1;
  }
  if (service === null) {
    io.stderr.write(`${file} is not a service.json this command can keep: fix it by hand. Nothing was written.\n`);
    return 1;
  }
  const value = VALUES[arg2];
  // Past here the service would refuse to start (config.js).
  if (value && service.profile !== undefined && service.profile !== 'agent') {
    io.stderr.write('remoteWindow needs profile: agent. Nothing was written.\n');
    return 1;
  }
  const features = service.features || {};
  const was = Object.hasOwn(features, arg) ? features[arg] : DEFAULT_FEATURES[arg];
  if (Object.hasOwn(features, arg) && was === value) {
    io.stdout.write(`features.${arg} is already ${value}.\n`);
    return 0;
  }
  try {
    (deps.write || writeKeepingOwnership)(file, `${JSON.stringify({ ...service, features: { ...features, [arg]: value } }, null, 2)}\n`);
  } catch (err) {
    io.stderr.write(`Cannot write ${file} (${err.code || 'unknown'}): run this as the account that owns it. Nothing was changed.\n`);
    return 1;
  }
  io.stdout.write(`features.${arg}: ${was} -> ${value}\n`);
  io.stdout.write('Start the service for this to take effect.\n');
  return 0;
}

module.exports = { runFeaturesCommand };
