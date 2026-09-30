// The scopes the front door can grant (§3.4). A scope is advertised only
// once it is registered here and listed in frontdoor.oauth.scopes_enabled;
// C7 registers cases:read and cases:answer the same way (program §4.19;
// management surfaces spec §3.3); cases:write is never registered.
const { REQUIRED_SCOPE } = require('../../fleet/scope-rules');

const SCOPE_RE = /^[a-z][a-z0-9-]{0,31}:[a-z][a-z0-9_-]{0,31}$/;

// fleet:unsafe is a modifier on fleet:run's run_runbook (§3.4): it lists that
// tool for the record but never grants it, never shows it, and never answers
// requiredScopeFor.
const UNSAFE = 'fleet:unsafe';

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// The fleet: namespace is fixed by createFleetScopeRegistry, which opens this
// flag only while it registers the four fleet scopes (synchronously). Nothing
// else can add a fleet: scope, so fleet:unsafe's `requires` rule cannot be
// dropped or replaced.
let registeringFleet = false;

const isScopeName = (v) => typeof v === 'string' && SCOPE_RE.test(v);

class ScopeRegistry {
  #scopes = new Map();

  // `requires`: the grant must also carry at least one of these scopes.
  // A fleet tool may be listed only by the scope REQUIRED_SCOPE names for it
  // (and run_runbook by fleet:unsafe); any other tool by one scope only, so a
  // later registration can neither claim a fleet tool nor take over another
  // scope's tool.
  register(name, { tools, description = '', requires = null } = {}) {
    if (!isScopeName(name)) throw new TypeError(`bad scope name "${name}"`);
    if (name.startsWith('fleet:') && !registeringFleet) throw new Error(`scope ${name}: the fleet: namespace is registered only by createFleetScopeRegistry`);
    if (this.#scopes.has(name)) throw new Error(`scope ${name} is already registered`);
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === 'string' && t.length > 0)) {
      throw new TypeError(`scope ${name}: tools must be a list of tool names`);
    }
    if (requires !== null && (!Array.isArray(requires) || requires.length === 0 || !requires.every(isScopeName))) {
      throw new TypeError(`scope ${name}: requires must be a non-empty list of scope names`);
    }
    for (const t of tools) {
      if (hasOwn(REQUIRED_SCOPE, t)) {
        const own = REQUIRED_SCOPE[t] === name || (name === UNSAFE && t === 'run_runbook');
        if (!own) throw new Error(`scope ${name}: tool ${t} belongs to ${REQUIRED_SCOPE[t]}`);
        continue;
      }
      for (const s of this.#scopes.values()) {
        if (s.tools.includes(t)) throw new Error(`scope ${name}: tool ${t} already belongs to ${s.name}`);
      }
    }
    this.#scopes.set(name, Object.freeze({
      name,
      tools: Object.freeze([...tools]),
      description: String(description),
      requires: requires ? Object.freeze([...requires]) : null
    }));
  }

  has(name) {
    return this.#scopes.has(name);
  }

  get(name) {
    return this.#scopes.get(name) || null;
  }

  names() {
    return [...this.#scopes.keys()].sort();
  }

  supported(enabled) {
    const on = new Set(Array.isArray(enabled) ? enabled : []);
    return this.names().filter((n) => on.has(n));
  }

  rules(enabled) {
    const supported = this.supported(enabled);
    const requires = {};
    for (const n of supported) {
      const s = this.#scopes.get(n);
      if (s.requires) requires[n] = [...s.requires];
    }
    return { supported, requires };
  }

  // The scope a tool call needs: the fleet table first, then the registered
  // scope that lists the tool (C7's cases:* tools).
  requiredScopeFor(tool) {
    if (typeof tool !== 'string') return null;
    if (hasOwn(REQUIRED_SCOPE, tool)) return REQUIRED_SCOPE[tool];
    for (const s of this.#scopes.values()) if (s.name !== UNSAFE && s.tools.includes(tool)) return s.name;
    return null;
  }

  toolsFor(scopeNames) {
    const out = new Set();
    for (const n of Array.isArray(scopeNames) ? scopeNames : []) {
      const s = this.#scopes.get(n);
      if (s && n !== UNSAFE) for (const t of s.tools) out.add(t);
    }
    return out;
  }
}

function createFleetScopeRegistry() {
  const r = new ScopeRegistry();
  registeringFleet = true;
  try {
    registerFleetScopes(r);
  } finally {
    registeringFleet = false;
  }
  return r;
}

function registerFleetScopes(r) {
  r.register('fleet:read', { tools: ['list_machines', 'describe_machine', 'get_state', 'get_job', 'get_job_logs'], description: 'See machines, their state and their jobs' });
  r.register('fleet:run', { tools: ['run_runbook', 'cancel_job'], description: 'Start read and routine runbooks, and cancel jobs' });
  r.register('fleet:unsafe', {
    tools: ['run_runbook'],
    description: 'Ask for unsafe runbooks and unsafe actions in agent sessions (each one still needs your phone)',
    requires: ['fleet:run', 'fleet:delegate']
  });
  r.register('fleet:delegate', { tools: ['delegate', 'send_to_job'], description: 'Start and continue agent sessions on agent machines' });
}

module.exports = { ScopeRegistry, createFleetScopeRegistry, SCOPE_RE };
