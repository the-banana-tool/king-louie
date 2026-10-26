'use strict';

// Personal hosting (spec 2026-10-25-personal-node-design.md §6): the service
// runs as the account that owns its data dir and config dir. That fact,
// checked once at start, stands in for the fleet layout's account checks, so
// anything else (an Administrators- or root-owned config dir, a link, an
// owner that cannot be read) refuses the start.

const fs = require('fs');

function readWindowsOwners(paths, inspectOwners) {
  const inspect = inspectOwners || require('../desktop-bridge/pairing').inspectWindowsOwners;
  let result;
  try {
    result = inspect(paths);
  } catch {
    return { me: '', entries: paths.map(() => null) };
  }
  const entries = Array.isArray(result && result.entries) ? result.entries : [];
  return {
    me: String((result && result.me) || ''),
    entries: paths.map((_, i) => {
      const e = entries[i];
      if (!e || !e.owner || e.owner === '(none)') return e && e.link ? { owner: null, link: true } : null;
      return { owner: String(e.owner), link: Boolean(e.link) };
    })
  };
}

function readPosixOwners(paths, { geteuid, statSync, lstatSync }) {
  return {
    me: String(geteuid()),
    entries: paths.map((p) => {
      try {
        if (lstatSync(p).isSymbolicLink()) return { owner: null, link: true };
        return { owner: String(statSync(p).uid), link: false };
      } catch {
        return null;
      }
    })
  };
}

function checkPersonalOwner({
  dataDir,
  configDir,
  platform = process.platform,
  inspectOwners,
  geteuid = () => process.geteuid(),
  statSync = fs.statSync,
  lstatSync = fs.lstatSync
} = {}) {
  const paths = [dataDir, configDir];
  const { me, entries } = platform === 'win32'
    ? readWindowsOwners(paths, inspectOwners)
    : readPosixOwners(paths, { geteuid, statSync, lstatSync });
  const owners = {
    dataDir: entries[0] ? entries[0].owner : null,
    configDir: entries[1] ? entries[1].owner : null
  };
  let problem = null;
  for (let i = 0; i < paths.length && !problem; i++) {
    const entry = entries[i];
    if (entry && entry.link) problem = `${paths[i]} is a link`;
    else if (!entry || !entry.owner) problem = `the owner of ${paths[i]} could not be read`;
    else if (!me) problem = `the account this process runs as could not be read`;
    else if (entry.owner !== me) problem = `${paths[i]} is owned by ${entry.owner}, not this account (${me})`;
  }
  return { ok: problem === null, me, owners, problem };
}

function assertPersonalOwner(options) {
  const result = checkPersonalOwner(options);
  if (!result.ok) {
    const err = new Error(`Refusing to start: hosting is personal but ${result.problem}`);
    err.code = 'PERSONAL_NOT_OWNER';
    throw err;
  }
  return result;
}

module.exports = { checkPersonalOwner, assertPersonalOwner };
