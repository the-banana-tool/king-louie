// src/cases/executors/package-loader.js
// Executor packages (cases stage 3 spec §3.2): the skill-package layout plus
// a kingLouie.executor block. Load checks 1–6 decide availability. There is
// no sandbox: the protections are the load root, the required pin and no
// Skill exposure (the adapter runs with full privileges once loaded).
//
// What the pin does and does not cover:
// - The pin covers the package's own files: every file outside node_modules/
//   (the spec formula). A link whose real target leaves the package makes it
//   unhashable, and loadAdapter re-hashes right before it requires main.
// - A package that ships a node_modules directory, at any depth, is refused:
//   executor packages bundle their dependencies into their own files.
// - Bare requires (`require('x')`) are resolved by Node from the package's
//   own location upward, then NODE_PATH and the global folders. They do NOT
//   reach King Louie's own installed dependencies (those sit under the app).
//   So a node_modules directly inside the executor root, or in any directory
//   between the root and the package, is refused as well. Directories above
//   the root, NODE_PATH and the global folders are part of the admin's
//   environment and are not checked; nothing pins what a bare require finds
//   there. Builtins and the king-louie/* aliases (installed by the skill
//   loader) resolve as usual.
// - A loaded adapter runs in-process with full privileges (spec §3.2 Trust):
//   it can require or read anything and bypass host.fetch. The load checks
//   decide what gets loaded; nothing confines it afterwards.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../logging');
// Requiring the skill loader installs the king-louie/* aliases packages use.
require('../../skills/skill-loader');
// Called through the module object so the binding stays the service's real
// check (and a test can observe the arguments it gets).
const serviceConfig = require('../../service/config');
const { sha256hex, EXECUTOR_ID_PATTERN } = require('./util');

const VAULT_REF = /^\$\{vault:([A-Za-z0-9._-]+)\}$/;
const ADAPTER_FUNCTIONS = Object.freeze(['capabilities', 'submit', 'status', 'results', 'cancel', 'briefRules']);
const CONFIG_TYPES = new Set(['string', 'number', 'boolean']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Request options host.fetch passes on. Anything else (a custom dispatcher,
// say) could send the request somewhere other than the URL checked here.
const FETCH_INIT_KEYS = Object.freeze(['method', 'headers', 'body', 'signal', 'duplex', 'keepalive']);
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
// assertAdminOwned's refusal wording for the executor roots (M16).
const EXECUTOR_ROOT_CONTROLS = Object.freeze({
  decides: 'which executor packages this service loads',
  selfGrant: 'swap an executor package'
});

class ExecutorUnavailableError extends Error {
  constructor(id, reason) {
    super(`${id} is unavailable: ${reason}`);
    this.name = 'ExecutorUnavailableError';
    this.code = 'EXECUTOR_UNAVAILABLE';
    this.executorId = id;
    this.reason = reason;
  }
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const messageOf = (err) => (err && typeof err.message === 'string' ? err.message : String(err));
// Windows paths compare case-insensitively.
const keyOf = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const posixRel = (from, to) => path.relative(from, to).split(path.sep).join('/');

function realOrNull(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Inside the package and outside every node_modules/ in it: the files the
// hash covers.
function covered(real, realDir) {
  return inside(real, realDir) && !path.relative(realDir, real).split(path.sep).includes('node_modules');
}

// True when the package has a node_modules entry at any depth (links are
// not followed).
function hasNodeModules(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') return true;
    if (entry.isDirectory() && hasNodeModules(path.join(dir, entry.name))) return true;
  }
  return false;
}

// The first node_modules a bare require from the package would search on the
// way up to the executor root (root included), or null.
function nodeModulesUpToRoot(realDir, root) {
  for (let d = path.dirname(realDir); ; d = path.dirname(d)) {
    const candidate = path.join(d, 'node_modules');
    if (fs.existsSync(candidate) || isLink(candidate)) return candidate;
    if (keyOf(d) === keyOf(root) || path.dirname(d) === d) return null;
  }
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Every file the pin covers, without following links. A link is hashed by
// its real target relative to the package; the target's own bytes are
// hashed at its own path.
function walkPackage(realDir) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      const rel = posixRel(realDir, full);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) {
        const target = realOrNull(full);
        if (!target) throw new Error(`${rel} is a link that does not resolve`);
        if (!covered(target, realDir)) throw new Error(`${rel} escapes the package`);
        files.push({ rel, abs: null, digest: sha256hex(`link:${posixRel(realDir, target)}`) });
      } else if (st.isDirectory()) {
        visit(full);
      } else if (st.isFile()) {
        files.push({ rel, abs: full, digest: sha256hex(fs.readFileSync(full)) });
      }
    }
  };
  visit(realDir);
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function hashPackage(dir) {
  const realDir = fs.realpathSync.native(dir);
  const files = walkPackage(realDir);
  const sha = sha256hex(files.map((f) => `${f.rel}\0${f.digest}\n`).join(''));
  return { realDir, sha, files };
}

// SHA-256 over the sorted `relative-path\0sha256(file)\n` lines of every
// file outside node_modules/ (spec §3.2, check 4). Throws when a link leaves
// the package.
function computePackageSha256(dir) {
  return hashPackage(dir).sha;
}

function readManifest(dir) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (err) {
    return { ok: false, error: err.code === 'ENOENT' ? 'no package.json in the package' : `package.json is not valid JSON: ${err.message}` };
  }
  if (!isPlainObject(pkg)) return { ok: false, error: 'package.json is not an object' };
  const manifest = pkg.kingLouie?.executor;
  if (!isPlainObject(manifest)) return { ok: false, error: 'package.json has no kingLouie.executor block', pkg };
  return { ok: true, pkg, manifest };
}

// Check 5. Errors name fields and vault keys, never values.
function resolveConfig(schema = {}, config = {}, vault = null) {
  const fail = (error) => ({ ok: false, error });
  if (!isPlainObject(schema)) return fail('configSchema must be an object');
  const given = config === undefined || config === null ? {} : config;
  if (!isPlainObject(given)) return fail('config must be an object');
  for (const [field, spec] of Object.entries(schema)) {
    if (FORBIDDEN_KEYS.has(field)) return fail(`configSchema field "${field}" is not allowed`);
    if (spec !== null && spec !== undefined && !isPlainObject(spec)) return fail(`configSchema field "${field}" must be an object`);
    const type = spec?.type ?? 'string';
    if (!CONFIG_TYPES.has(type) || (spec?.secret && type !== 'string')) {
      return fail(`configSchema field "${field}" has unsupported type ${JSON.stringify(type)}`);
    }
  }
  for (const key of Object.keys(given)) {
    if (!Object.hasOwn(schema, key)) return fail(`config field "${key}" is not in the package's configSchema`);
  }
  const out = {};
  for (const [field, rawSpec] of Object.entries(schema)) {
    const spec = rawSpec || {};
    const raw = Object.hasOwn(given, field) ? given[field] : undefined;
    if (raw === undefined || raw === null || raw === '') {
      if (spec.required) return fail(`config field "${field}" is required`);
      continue;
    }
    if (spec.secret) {
      const ref = typeof raw === 'string' ? VAULT_REF.exec(raw) : null;
      if (!ref) return fail(`store ${field} in the vault and reference it as \${vault:<key>}`);
      let value;
      try {
        value = vault && typeof vault.get === 'function' ? vault.get(ref[1]) : null;
      } catch {
        return fail(`vault key "${ref[1]}" for ${field} could not be read`);
      }
      if (typeof value !== 'string' || value === '') return fail(`vault key "${ref[1]}" for ${field} does not exist`);
      out[field] = value;
      continue;
    }
    const type = spec.type || 'string';
    if (typeof raw !== type) return fail(`config field "${field}" must be a ${type}`);
    out[field] = raw;
  }
  return { ok: true, config: out };
}

const defaultGeteuid = () => (typeof process.geteuid === 'function' ? process.geteuid() : -1);

// The service-mode root check (check 3): the service's real assertAdminOwned
// bound to its adminUid (M16). A no-op on win32, where the installer's ACL is
// the protection.
function makeRootAssert({ adminUid = 0, geteuid = defaultGeteuid } = {}) {
  return (root) => serviceConfig.assertAdminOwned(root, geteuid, adminUid, EXECUTOR_ROOT_CONTROLS);
}

// Checks 1–5. Never throws. The resolved config is a copy, kept off the
// enumerable result so logging or serializing the result cannot leak it.
function checkPackage({
  id, entry = {}, dir, roots = [], isService = false, assertRoot = null, vault = null, adminUid = 0, geteuid = defaultGeteuid
}) {
  const base = { ok: false, error: null, dir, manifest: null, pkg: null, computed: null };
  if (typeof id !== 'string' || !EXECUTOR_ID_PATTERN.test(id)) return { ...base, error: `executor id ${JSON.stringify(String(id))} is not valid` };
  const result = { ...base };
  const fail = (error) => ({ ...result, ok: false, error });
  try {
    const m = readManifest(dir);
    if (!m.ok) return fail(m.error);
    result.manifest = m.manifest;
    result.pkg = m.pkg;

    if (m.manifest.apiVersion !== 1) return fail(`manifest apiVersion must be 1 (found ${JSON.stringify(m.manifest.apiVersion)})`);
    if (m.manifest.id !== id) return fail(`manifest id ${JSON.stringify(m.manifest.id)} does not match entry id "${id}"`);

    const realDir = realOrNull(dir);
    if (!realDir) return fail('the package directory was not found');
    const main = typeof m.pkg.main === 'string' && m.pkg.main ? m.pkg.main : 'index.js';
    const realMain = realOrNull(path.resolve(realDir, main));
    if (!realMain) return fail(`main ${main} was not found`);
    if (!inside(realMain, realDir) && keyOf(realMain) !== keyOf(realDir)) return fail('main resolves outside the package');
    if (!covered(realMain, realDir) && keyOf(realMain) !== keyOf(realDir)) return fail('main is inside node_modules, which the pin does not cover');
    if (!fs.statSync(realMain).isFile()) return fail('main must name a file in the package');

    const root = (Array.isArray(roots) ? roots : [])
      .filter((r) => typeof r === 'string' && r !== '')
      .map(realOrNull)
      .filter(Boolean)
      .find((r) => inside(realDir, r));
    if (!root) {
      return fail(`the package is outside the executor roots (${isService ? 'service.json executors.packageRoots' : 'the executors folder of the data directory'})`);
    }
    if (isService) {
      try {
        (assertRoot || makeRootAssert({ adminUid, geteuid }))(root);
      } catch (err) {
        return fail(messageOf(err));
      }
    }

    if (hasNodeModules(realDir)) return fail('executor packages must bundle their dependencies (node_modules is not allowed)');
    const above = nodeModulesUpToRoot(realDir, root);
    if (above) {
      return fail(`executor roots must not contain node_modules: bare requires from the package would load it unpinned (found ${posixRel(root, above)})`);
    }

    result.computed = hashPackage(realDir).sha;
    const pin = entry && typeof entry.packageSha256 === 'string' ? entry.packageSha256 : '';
    if (!pin) return fail(`pin required: set packageSha256 to ${result.computed}`);
    if (pin !== result.computed) return fail(`package changed: expected ${pin}, found ${result.computed}`);

    const cfg = resolveConfig(m.manifest.configSchema ?? {}, entry.config ?? {}, vault);
    if (!cfg.ok) return fail(cfg.error);
    const ok = { ...result, ok: true, error: null, realDir, mainPath: realMain };
    Object.defineProperty(ok, 'config', { value: Object.freeze(cfg.config), enumerable: false });
    return ok;
  } catch (err) {
    return fail(messageOf(err));
  }
}

// A re-pinned package must load its new code, not modules cached from the
// previous load.
function dropCachedModules(realDir) {
  for (const key of Object.keys(require.cache)) {
    const real = realOrNull(key);
    if (real && inside(real, realDir)) delete require.cache[key];
  }
}

// ---- host.fetch ----

function httpUrl(value) {
  if (typeof value !== 'string' && !(value instanceof URL)) return null;
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

// The adapter's only network path: its manifest origins, a timeout, no
// redirects, no credentials in the URL. Origins compare after WHATWG URL
// normalization (case, default port, IDN to punycode, IPv4 forms), so a
// look-alike host or another scheme or port is another origin. Refusals name
// the origin only, never the path, query or userinfo. (The adapter can still
// reach the network directly; see Trust, §3.2.)
function makeHostFetch({ origins = [], config = {}, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, fetchImpl = null } = {}) {
  const cfg = config || {};
  const allowed = new Set((Array.isArray(origins) ? origins : [])
    .filter((o) => typeof o === 'string')
    .map((o) => httpUrl(o.startsWith('config:') ? (Object.hasOwn(cfg, o.slice(7)) ? cfg[o.slice(7)] : null) : o))
    .filter(Boolean)
    .map((u) => u.origin));
  const timeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  return async (url, init = {}) => {
    const target = httpUrl(url);
    if (!target) throw new Error('host.fetch takes an absolute http(s) URL as a string or URL');
    if (target.username || target.password) throw new Error(`a URL with credentials for ${target.origin} is outside this executor's origins`);
    if (!allowed.has(target.origin)) throw new Error(`${target.origin} is outside this executor's origins`);
    const options = {};
    if (isPlainObject(init)) for (const key of FETCH_INIT_KEYS) if (Object.hasOwn(init, key)) options[key] = init[key];
    const timeout = AbortSignal.timeout(timeoutMs);
    options.signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    options.redirect = 'error';
    return (fetchImpl || globalThis.fetch)(target.href, options);
  };
}

// ---- check 6 ----

function secretValues(checked) {
  const schema = isPlainObject(checked?.manifest?.configSchema) ? checked.manifest.configSchema : {};
  const config = checked?.config || {};
  return Object.entries(schema)
    .filter(([field, spec]) => spec?.secret && typeof config[field] === 'string' && config[field] !== '')
    .map(([field]) => config[field])
    .sort((a, b) => b.length - a.length);
}

function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('[redacted]');
  return out;
}

// Check 6: createAdapter returns all six functions and its capabilities are
// within the manifest's and the entry's. Every failure is an
// ExecutorUnavailableError whose reason carries no secret value.
async function loadAdapter(checked, {
  id, entry = {}, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, fetchImpl = null, now = () => new Date()
} = {}) {
  const execId = id || checked?.manifest?.id || 'executor';
  const secrets = secretValues(checked);
  const unavailable = (reason) => new ExecutorUnavailableError(execId, redact(reason, secrets));
  if (!checked || !checked.ok) throw unavailable(checked?.error || 'the package has not passed its load checks');

  // The bytes about to load must be the bytes that were checked.
  let hashed;
  try {
    hashed = hashPackage(checked.realDir);
  } catch (err) {
    throw unavailable(messageOf(err));
  }
  if (hashed.sha !== checked.computed) {
    throw unavailable(`package changed since it was checked: expected ${checked.computed}, found ${hashed.sha}`);
  }
  dropCachedModules(hashed.realDir);

  let mod;
  try {
    mod = require(checked.mainPath);
  } catch (err) {
    throw unavailable(`main failed to load: ${messageOf(err)}`);
  }
  if (typeof mod?.createAdapter !== 'function') throw unavailable('main does not export createAdapter');
  const host = Object.freeze({
    id: execId,
    log: createLogger('executor').child(execId),
    fetch: makeHostFetch({ origins: checked.manifest.origins || [], config: checked.config, requestTimeoutMs, fetchImpl }),
    now
  });
  let adapter;
  try {
    adapter = await mod.createAdapter({ ...checked.config }, host);
  } catch (err) {
    throw unavailable(`createAdapter failed: ${messageOf(err)}`);
  }
  const missing = ADAPTER_FUNCTIONS.filter((fn) => typeof adapter?.[fn] !== 'function');
  if (missing.length) throw unavailable(`the adapter is missing ${missing.join(', ')}`);
  let capabilities;
  try {
    capabilities = await adapter.capabilities();
  } catch (err) {
    throw unavailable(`capabilities() failed: ${messageOf(err)}`);
  }
  const claimed = capabilities?.capabilities;
  if (!Array.isArray(claimed) || claimed.some((c) => typeof c !== 'string')) {
    throw unavailable("the adapter's capabilities must be an array of strings");
  }
  const manifestCaps = Array.isArray(checked.manifest.capabilities) ? checked.manifest.capabilities : [];
  const entryCaps = Array.isArray(entry?.capabilities) && entry.capabilities.length ? entry.capabilities : manifestCaps;
  const extra = claimed.filter((c) => !manifestCaps.includes(c) || !entryCaps.includes(c));
  if (extra.length) throw unavailable(`the adapter claims capabilities outside its manifest or entry: ${extra.join(', ')}`);
  return { adapter, capabilities };
}

module.exports = {
  ADAPTER_FUNCTIONS,
  EXECUTOR_ROOT_CONTROLS,
  ExecutorUnavailableError,
  computePackageSha256,
  readManifest,
  resolveConfig,
  makeRootAssert,
  checkPackage,
  makeHostFetch,
  loadAdapter
};
