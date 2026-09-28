// src/service/commands/models.js
// `king-louie-service models` and `profiles` (models spec 2026-09-27 §12):
// the catalog and provider statuses, a refresh, and the profiles headless
// runs resolve through (the default one, M-D12). CLI output goes to
// io.stdout and io.stderr on purpose.

const MODELS_USAGE = 'Usage: king-louie-service models status|refresh [--data-dir DIR]\n';
const PROFILES_USAGE = 'Usage: king-louie-service profiles list|show <id-or-name>|set-default <id-or-name> [--data-dir DIR]\n';

// A running service holds its own copy of the stores and would overwrite a
// change made underneath it.
function refuseWhileRunning(dataDir, io, runningServicePid) {
  const pid = runningServicePid(dataDir);
  if (!pid) return false;
  io.stderr.write(`The service is running (pid ${pid}) on ${dataDir}. Stop it first, run this again, then start it.\n`);
  return true;
}

function formatCatalog(status) {
  const date = String(status.fetchedAt || status.snapshotDate || 'unknown date').slice(0, 10);
  return `Catalog: ${status.source}, ${date} (${status.models} models)${status.stale ? ' — old: run "models refresh"' : ''}\n`;
}

function formatProviders(statuses) {
  const lines = ['Providers:'];
  for (const [provider, s] of Object.entries(statuses || {})) {
    let state;
    if (!s) state = 'not tested';
    else if (s.ok) state = `ok      ${s.checkedAt || ''}  ${Array.isArray(s.models) ? s.models.length : 0} models`;
    else state = `failed  ${s.checkedAt || ''}  ${s.error || s.message || 'unknown error'}`;
    lines.push(`  ${provider.padEnd(11)}${state}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runModelsCommand({ sub, dataDir, io, deps }) {
  if (sub !== 'status' && sub !== 'refresh') {
    io.stderr.write(MODELS_USAGE);
    return 2;
  }
  if (sub === 'refresh' && refuseWhileRunning(dataDir, io, deps.runningServicePid)) return 1;
  return deps.withServiceCore(dataDir, io, async (core) => {
    const { catalog, availability } = core.models;
    if (sub === 'refresh') {
      await catalog.refresh({ force: true });
      const tested = Object.keys(await availability.testAll());
      io.stdout.write(`Tested ${tested.length} provider${tested.length === 1 ? '' : 's'}.\n`);
    }
    io.stdout.write(formatCatalog(catalog.status()));
    io.stdout.write(formatProviders(availability.statusAll()));
    return 0;
  });
}

// By id, else by name, ignoring case.
function findProfile(profiles, ref) {
  const want = String(ref || '').trim();
  if (!want) return null;
  const list = profiles.list();
  return list.find((p) => p.id === want) || list.find((p) => p.name.toLowerCase() === want.toLowerCase()) || null;
}

const label = (t) => `${t.provider}/${t.model}`;

function formatProfile(profile, { defaultId, explainTarget }) {
  const lines = [`${profile.id === defaultId ? '* ' : '  '}${profile.name} (${profile.id}, ${profile.kind})`];
  for (const [role, list] of Object.entries(profile.roles)) {
    if (!list.length) {
      lines.push(`    ${role}: (none)`);
      continue;
    }
    lines.push(`    ${role}:`);
    for (const t of list) {
      const verdict = explainTarget(t.provider, t.model, {}) || {};
      const state = verdict.usable ? 'usable' : `not usable: ${(verdict.reasons || []).join(' ')}`;
      lines.push(`      ${label(t)}${t.effort ? ` @${t.effort}` : ''}  ${state}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function runProfilesCommand({ sub, arg, dataDir, io, deps }) {
  if (!['list', 'show', 'set-default'].includes(sub) || (sub !== 'list' && !arg)) {
    io.stderr.write(PROFILES_USAGE);
    return 2;
  }
  if (sub === 'set-default' && refuseWhileRunning(dataDir, io, deps.runningServicePid)) return 1;
  return deps.withServiceCore(dataDir, io, (core) => {
    const profiles = core.models.profiles;
    const defaultId = profiles.defaultId();
    if (sub === 'list') {
      const list = profiles.list();
      if (!list.length) io.stdout.write('No profiles.\n');
      for (const p of list) {
        io.stdout.write(`${p.id === defaultId ? '* ' : '  '}${p.id}  ${p.name}  (${p.kind})  main: ${p.roles.main.map(label).join(', ') || '(none)'}\n`);
      }
      return 0;
    }
    const profile = findProfile(profiles, arg);
    if (!profile) {
      io.stderr.write(`No profile "${arg}". Run "king-louie-service profiles list".\n`);
      return 1;
    }
    if (sub === 'show') {
      io.stdout.write(formatProfile(profile, { defaultId, explainTarget: core.context.explainTarget }));
      return 0;
    }
    profiles.setDefault(profile.id);
    io.stdout.write(`${profile.name} is now the default profile. Headless runs use it from the next start.\n`);
    return 0;
  });
}

module.exports = { runModelsCommand, runProfilesCommand };
