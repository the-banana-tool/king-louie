// Which OAuth scope each fleet tool needs, shared by the front door's router
// and the node's own re-check (fleet stage 4 §3.4, §3.7). Pure: the runbook
// profile loads it, so it requires nothing. On a node this re-check bounds
// router bugs, not a compromised front door: the scopes it reads are the
// ones the front door put in `origin.scopes` (§8).
//
// Fail closed everywhere: a malformed scope list allows nothing, an unknown
// scope grants nothing, there is no wildcard, and a machine limit matches
// exact names only.

// Copies of Task 1's SCOPE_RE and MACHINE_NAME_RE
// (src/frontdoor/protocol/messages.js); tests/fleet-scope-rules.test.js keeps
// them equal.
const SCOPE_NAME_RE = /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9_-]{0,31}$/;
const MACHINE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const bare = (re) => re.source.slice(1, -1);
const SCOPE_NAME = bare(SCOPE_NAME_RE);
const MACHINE = bare(MACHINE_NAME_RE);
const SCOPE_STRING_RE = new RegExp(`^(${SCOPE_NAME})(?:;machines=(${MACHINE}(?:,${MACHINE})*))?$`);

const REQUIRED_SCOPE = Object.freeze({
  list_machines: 'fleet:read',
  describe_machine: 'fleet:read',
  get_state: 'fleet:read',
  get_job: 'fleet:read',
  get_job_logs: 'fleet:read',
  run_runbook: 'fleet:run',
  cancel_job: 'fleet:run',
  delegate: 'fleet:delegate',
  send_to_job: 'fleet:delegate'
});

// Runbook tiers that fleet:run covers on its own. Every other tier, including
// one this module does not know, also needs fleet:unsafe. `null` means the
// caller has no tier (an unknown runbook, which the engine then refuses).
const TIERS_WITHOUT_UNSAFE = new Set([null, 'read', 'routine']);

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isScopeName = (v) => typeof v === 'string' && SCOPE_NAME_RE.test(v);

function invalid(text) {
  return Object.assign(new Error(`invalid_scope: ${text}`), { code: 'invalid_scope' });
}

function checkSortedUnique(machines, label) {
  for (let i = 1; i < machines.length; i += 1) {
    if (!(machines[i - 1] < machines[i])) throw invalid(`machines in ${label} must be sorted and unique`);
  }
}

function parseScope(str) {
  if (typeof str !== 'string') throw invalid('a scope is a string');
  const m = SCOPE_STRING_RE.exec(str);
  if (!m) throw invalid(`"${str}" is not <scope>[;machines=a,b]`);
  const machines = m[2] ? m[2].split(',') : null;
  if (machines) checkSortedUnique(machines, `"${str}"`);
  return { scope: m[1], machines };
}

// An object entry is checked field by field, never by formatting it and
// parsing the result: a name like "a,b" must not turn into two names, and an
// empty or missing `machines` must not turn into "all machines".
function checkEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid('a scope entry is { scope, machines }');
  const { scope, machines } = entry;
  if (!isScopeName(scope)) throw invalid(`"${scope}" is not a scope name`);
  if (machines === null) return { scope, machines: null };
  if (!Array.isArray(machines) || machines.length === 0) throw invalid(`${scope}: machines is null or a non-empty list`);
  for (const n of machines) {
    if (typeof n !== 'string' || !MACHINE_NAME_RE.test(n)) throw invalid(`${scope}: "${n}" is not a machine name`);
  }
  checkSortedUnique(machines, scope);
  return { scope, machines: [...machines] };
}

function formatScope(entry) {
  const { scope, machines } = checkEntry(entry);
  return machines ? `${scope};machines=${machines.join(',')}` : scope;
}

function normalizeScopes(list) {
  if (!Array.isArray(list)) throw invalid('scopes must be a list');
  const out = list.map((s) => (typeof s === 'string' ? parseScope(s) : checkEntry(s)));
  const seen = new Set();
  for (const e of out) {
    // Two entries for one scope would make the answer depend on their order.
    if (seen.has(e.scope)) throw invalid(`${e.scope} appears twice`);
    seen.add(e.scope);
  }
  return out;
}

const entryFor = (list, name) => list.find((e) => e.scope === name) || null;

// A machine is a non-empty string. An unrestricted entry covers any such name
// (a node whose name has capitals can only be granted that way, Deviation 18);
// a restricted one covers only the exact names it lists.
const covers = (entry, machine) =>
  typeof machine === 'string' && machine.length > 0 && (entry.machines === null || entry.machines.includes(machine));

// `machine`: the target node's name. Omitted or null means the call targets no
// single machine (the router's scope-only check before it resolves one, and
// `list_machines`, which filters with machineVisible). Present but not a name
// (`undefined` from a missing argument, '', a non-string) matches nothing.
// `required`: the scope for a tool outside REQUIRED_SCOPE (C7's tools); it
// never replaces a fleet tool's own scope.
function allows(scopes, tool, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const fixed = typeof tool === 'string' && hasOwn(REQUIRED_SCOPE, tool) ? REQUIRED_SCOPE[tool] : null;
  const need = fixed || (isScopeName(o.required) ? o.required : null);
  let list;
  try {
    list = normalizeScopes(scopes);
  } catch {
    return { ok: false, code: 'insufficient_scope', required: need };
  }
  if (!need) return { ok: false, code: 'insufficient_scope', required: null };
  const entry = entryFor(list, need);
  if (!entry) return { ok: false, code: 'insufficient_scope', required: need };
  const targeted = hasOwn(o, 'machine') && o.machine !== null;
  if (targeted && !covers(entry, o.machine)) return { ok: false, code: 'unknown_machine', required: need };
  const tier = o.tier === undefined ? null : o.tier;
  if (tool === 'run_runbook' && !TIERS_WITHOUT_UNSAFE.has(tier)) {
    const unsafe = entryFor(list, 'fleet:unsafe');
    if (!unsafe || (targeted && !covers(unsafe, o.machine))) return { ok: false, code: 'insufficient_scope', required: 'fleet:unsafe' };
  }
  return { ok: true };
}

function machineVisible(scopes, machine) {
  try {
    const entry = entryFor(normalizeScopes(scopes), 'fleet:read');
    return Boolean(entry) && covers(entry, machine);
  } catch {
    return false;
  }
}

function hasScope(scopes, name) {
  try {
    return Boolean(entryFor(normalizeScopes(scopes), name));
  } catch {
    return false;
  }
}

module.exports = {
  REQUIRED_SCOPE,
  SCOPE_NAME_RE,
  MACHINE_NAME_RE,
  parseScope,
  formatScope,
  normalizeScopes,
  allows,
  machineVisible,
  hasScope
};
