// tests/cases-executor-package.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ExecutorUnavailableError, computePackageSha256, checkPackage, loadAdapter, makeHostFetch
} = require('../src/cases/executors/package-loader');
const { builtinEntry, BUILTIN_IDS, OUTBOUND_CAPABILITIES, DIRECT_TOOLS } = require('../src/cases/executors/builtins');
const SkillLoader = require('../src/skills/skill-loader');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-exec-pkg-'));
  dirs.push(d);
  return d;
}

const ADAPTER = `module.exports.createAdapter = (config, host) => ({
  capabilities: () => ({ capabilities: ['call'], cannot: [], constraints: {}, cost: {}, latency: 'async-hours', state: 'poll' }),
  submit: async () => ({ jobId: 'x' }),
  status: async () => ({ state: 'running', contacts: [] }),
  results: async () => ({ records: [] }),
  cancel: async () => ({ state: 'cancelled' }),
  briefRules: () => ['Say who you are calling for.'],
  config,
  host
});
`;

function writePackage(root, name, { manifest = {}, pkg = {}, adapter = ADAPTER } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: `kl-executor-${name}`, version: '1.0.0', main: 'adapter.js',
    kingLouie: {
      executor: {
        apiVersion: 1, id: name, kind: 'external-agent', capabilities: ['call', 'voicemail'], cannot: ['web-form', 'email', 'sms'],
        configSchema: { baseUrl: { type: 'string', required: true }, token: { type: 'string', secret: true, required: true } },
        payloadSchema: { venue: { type: 'string' } }, origins: ['config:baseUrl'], ...manifest
      }
    },
    ...pkg
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'adapter.js'), adapter);
  return dir;
}
const vault = { get: (k) => (k === 'errands-token' ? 'tok-test' : null) };
const entryFor = (dir, over = {}) => ({
  packageSha256: computePackageSha256(dir),
  config: { baseUrl: 'https://errands.example.com', token: '${vault:errands-token}' },
  ...over
});

describe('built-in executors', () => {
  it('matches the spec table', () => {
    assert.deepStrictEqual([...BUILTIN_IDS], ['bash', 'files', 'web', 'browser', 'workflow', 'runbook', 'owner']);
    const pick = (id) => {
      const e = builtinEntry(id);
      return [e.kind, e.direct, e.outbound, e.authority, e.latency];
    };
    assert.deepStrictEqual(pick('bash'), ['tool', true, 'none', 'none', 'interactive']);
    assert.deepStrictEqual(pick('web'), ['tool', true, 'query', 'none', 'interactive']);
    assert.deepStrictEqual(pick('browser'), ['tool', false, 'message', 'envelope', 'interactive']);
    assert.deepStrictEqual(pick('workflow'), ['tool', false, 'query', 'none', 'async-minutes']);
    assert.deepStrictEqual(pick('runbook'), ['runbook', false, 'none', 'none', 'async-minutes']);
    assert.deepStrictEqual(pick('owner'), ['owner', false, 'none', 'none', 'async-days']);
  });

  it('lists the outbound capabilities each non-owner built-in lacks', () => {
    assert.deepStrictEqual(builtinEntry('bash').cannot, [...OUTBOUND_CAPABILITIES]);
    assert.deepStrictEqual(builtinEntry('browser').cannot, ['call', 'sms', 'email', 'postal-mail', 'pay', 'sign']);
    assert.deepStrictEqual(builtinEntry('owner').cannot, []);
    assert.strictEqual(builtinEntry('phone-agent'), null);
    assert.notStrictEqual(builtinEntry('bash'), builtinEntry('bash'), 'a fresh copy each call');
    assert.strictEqual(DIRECT_TOOLS.web, 'WebSearch, WebFetch');
  });
});

describe('package pin', () => {
  it('hashes every file outside node_modules and changes with any file', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const a = computePackageSha256(dir);
    assert.match(a, /^[0-9a-f]{64}$/);
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'x');
    assert.strictEqual(computePackageSha256(dir), a);
    fs.appendFileSync(path.join(dir, 'adapter.js'), '\n// changed\n');
    assert.notStrictEqual(computePackageSha256(dir), a);
  });
});

describe('checkPackage', () => {
  it('passes a well-formed pinned package and resolves secrets from the vault', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const r = checkPackage({ id: 'phone-x', entry: entryFor(dir), dir, roots: [root], vault });
    assert.strictEqual(r.ok, true, r.error);
    assert.deepStrictEqual(r.config, { baseUrl: 'https://errands.example.com', token: 'tok-test' });
  });

  it('check 1: apiVersion and id', () => {
    const root = tmp();
    const v2 = writePackage(root, 'phone-x', { manifest: { apiVersion: 2 } });
    assert.match(checkPackage({ id: 'phone-x', entry: entryFor(v2), dir: v2, roots: [root], vault }).error, /apiVersion must be 1/);
    const other = writePackage(root, 'phone-y', { manifest: { id: 'phone-z' } });
    assert.strictEqual(checkPackage({ id: 'phone-y', entry: entryFor(other), dir: other, roots: [root], vault }).error, 'manifest id "phone-z" does not match entry id "phone-y"');
  });

  it('check 2: main must stay inside the package', () => {
    const root = tmp();
    fs.writeFileSync(path.join(root, 'outside.js'), ADAPTER);
    const dir = writePackage(root, 'phone-x', { pkg: { main: '../outside.js' } });
    assert.strictEqual(checkPackage({ id: 'phone-x', entry: entryFor(dir), dir, roots: [root], vault }).error, 'main resolves outside the package');
  });

  it('check 3: the package must sit under a root, admin-owned in service mode', () => {
    const root = tmp();
    const elsewhere = tmp();
    const dir = writePackage(elsewhere, 'phone-x');
    assert.match(checkPackage({ id: 'phone-x', entry: entryFor(dir), dir, roots: [root], vault }).error, /outside the executor roots/);
    const inRoot = writePackage(root, 'phone-x');
    const refused = checkPackage({
      id: 'phone-x', entry: entryFor(inRoot), dir: inRoot, roots: [root], vault, isService: true,
      assertRoot: () => { throw new Error('Refusing to read the executor root: it is owned by the service account'); }
    });
    assert.strictEqual(refused.error, 'Refusing to read the executor root: it is owned by the service account');
  });

  it('check 4: the pin is required and must match', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const computed = computePackageSha256(dir);
    const missing = checkPackage({ id: 'phone-x', entry: entryFor(dir, { packageSha256: null }), dir, roots: [root], vault });
    assert.strictEqual(missing.error, `pin required: set packageSha256 to ${computed}`);
    assert.strictEqual(missing.computed, computed);
    const wrong = checkPackage({ id: 'phone-x', entry: entryFor(dir, { packageSha256: 'a'.repeat(64) }), dir, roots: [root], vault });
    assert.strictEqual(wrong.error, `package changed: expected ${'a'.repeat(64)}, found ${computed}`);
  });

  it('check 5: secrets are vault references to existing keys; config matches the schema', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const run = (config) => checkPackage({ id: 'phone-x', entry: entryFor(dir, { config }), dir, roots: [root], vault }).error;
    assert.strictEqual(run({ baseUrl: 'https://errands.example.com', token: 'tok-plain' }), 'store token in the vault and reference it as ${vault:<key>}');
    assert.strictEqual(run({ baseUrl: 'https://errands.example.com', token: '${vault:missing}' }), 'vault key "missing" for token does not exist');
    assert.strictEqual(run({ token: '${vault:errands-token}' }), 'config field "baseUrl" is required');
    assert.strictEqual(run({ baseUrl: 'https://errands.example.com', token: '${vault:errands-token}', extra: 1 }), 'config field "extra" is not in the package\'s configSchema');
  });
});

describe('loadAdapter', () => {
  it('check 6: returns the adapter with a host that has no vault and fetches only its origins', async () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const checked = checkPackage({ id: 'phone-x', entry: entryFor(dir), dir, roots: [root], vault });
    const { adapter, capabilities } = await loadAdapter(checked, { id: 'phone-x', entry: { capabilities: ['call', 'voicemail'] } });
    assert.deepStrictEqual(capabilities.capabilities, ['call']);
    assert.deepStrictEqual(Object.keys(adapter.host).sort(), ['fetch', 'id', 'log', 'now']);
    assert.strictEqual(adapter.config.token, 'tok-test');
    await assert.rejects(adapter.host.fetch('https://elsewhere.example.com/x'), /outside this executor's origins/);
  });

  it('refuses an adapter missing a function or claiming extra capabilities', async () => {
    const root = tmp();
    const partial = writePackage(root, 'phone-x', { adapter: 'module.exports.createAdapter = () => ({ capabilities: () => ({ capabilities: [] }) });' });
    const checked = checkPackage({ id: 'phone-x', entry: entryFor(partial), dir: partial, roots: [root], vault });
    await assert.rejects(loadAdapter(checked, { id: 'phone-x', entry: {} }), (err) => (
      err instanceof ExecutorUnavailableError && err.code === 'EXECUTOR_UNAVAILABLE' && /missing submit, status, results, cancel, briefRules/.test(err.message)
    ));
    const greedy = writePackage(root, 'phone-y', { adapter: ADAPTER.replace("capabilities: ['call']", "capabilities: ['call', 'pay']") });
    const checkedGreedy = checkPackage({ id: 'phone-y', entry: entryFor(greedy), dir: greedy, roots: [root], vault });
    await assert.rejects(loadAdapter(checkedGreedy, { id: 'phone-y', entry: {} }), /outside its manifest or entry: pay/);
  });
});

describe('makeHostFetch', () => {
  it('passes allowed origins through with a timeout and no redirects', async () => {
    const calls = [];
    const fetch = makeHostFetch({
      origins: ['config:baseUrl', 'https://status.example.com'],
      config: { baseUrl: 'https://errands.example.com/api' },
      requestTimeoutMs: 1000,
      fetchImpl: async (url, init) => { calls.push([url, init.redirect, init.signal instanceof AbortSignal]); return { ok: true }; }
    });
    await fetch('https://errands.example.com/jobs');
    await fetch('https://status.example.com/ping');
    assert.deepStrictEqual(calls, [['https://errands.example.com/jobs', 'error', true], ['https://status.example.com/ping', 'error', true]]);
    await assert.rejects(fetch('http://errands.example.com/jobs'), /outside this executor's origins/);
  });
});

describe('skill loader', () => {
  it('does not treat an executor package as a skill', () => {
    const root = tmp();
    writePackage(root, 'phone-x');
    fs.mkdirSync(path.join(root, 'notes-skill'));
    fs.writeFileSync(path.join(root, 'notes-skill', 'package.json'), JSON.stringify({ name: 'notes-skill', main: 'index.js' }));
    const loader = new SkillLoader({ skillsDirectory: root, userDataPath: root });
    assert.deepStrictEqual(loader.discoverSkills().map((d) => path.basename(d)), ['notes-skill']);
    assert.strictEqual(SkillLoader.isExecutorPackage(path.join(root, 'phone-x')), true);
  });
});

// ---- security probes (beyond the brief) ----
const util = require('util');
const serviceConfig = require('../src/service/config');
const { ID_PATTERN } = require('../src/cases/executors/builtins');
const { EXECUTOR_ID_PATTERN } = require('../src/cases/executors/util');
const { EXECUTOR_ROOT_CONTROLS, makeRootAssert } = require('../src/cases/executors/package-loader');

// A directory link that works without privileges: a junction on Windows.
function linkDir(target, at) {
  fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
}
// File symlinks need a privilege on Windows; report whether one was made.
function tryLinkFile(target, at) {
  try {
    fs.symlinkSync(target, at, 'file');
    return true;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') return false;
    throw err;
  }
}
const check = (root, dir, id = 'phone-x', over = {}) => checkPackage({ id, entry: entryFor(dir), dir, roots: [root], vault, ...over });
const PIN_A = 'a'.repeat(64);
const CONFIG_OK = { baseUrl: 'https://errands.example.com', token: '${vault:errands-token}' };

describe('one executor id pattern (M18)', () => {
  it('builtins re-exports the util pattern object', () => {
    assert.strictEqual(ID_PATTERN, EXECUTOR_ID_PATTERN);
  });
});

describe('package pin: links cannot escape', () => {
  it('refuses a junction or directory link that leaves the package', () => {
    const root = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'evil.js'), 'module.exports = 1;');
    const dir = writePackage(root, 'phone-x');
    linkDir(outside, path.join(dir, 'lib'));
    assert.throws(() => computePackageSha256(dir), /lib escapes the package/);
    const r = checkPackage({ id: 'phone-x', entry: { packageSha256: PIN_A, config: CONFIG_OK }, dir, roots: [root], vault });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /lib escapes the package/);
  });

  it('refuses a file symlink that leaves the package', (t) => {
    const root = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'evil.js'), 'module.exports = 1;');
    const dir = writePackage(root, 'phone-x');
    if (!tryLinkFile(path.join(outside, 'evil.js'), path.join(dir, 'helper.js'))) {
      t.skip('file symlinks need a privilege here');
      return;
    }
    assert.throws(() => computePackageSha256(dir), /helper\.js escapes the package/);
  });

  it('refuses a link into node_modules, which the pin does not cover', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    linkDir(path.join(dir, 'node_modules', 'dep'), path.join(dir, 'lib'));
    assert.throws(() => computePackageSha256(dir), /lib escapes the package/);
  });

  it('hashes a link that stays inside by its target', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    fs.mkdirSync(path.join(dir, 'real'));
    fs.writeFileSync(path.join(dir, 'real', 'a.js'), 'x');
    const before = computePackageSha256(dir);
    linkDir(path.join(dir, 'real'), path.join(dir, 'alias'));
    assert.notStrictEqual(computePackageSha256(dir), before, 'adding a link changes the pin');
    assert.strictEqual(check(root, dir).ok, true);
  });
});

describe('checkPackage: main and roots', () => {
  it('refuses a package that ships node_modules at any depth', () => {
    const root = tmp();
    const top = writePackage(root, 'phone-x');
    fs.mkdirSync(path.join(top, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(top, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
    assert.strictEqual(check(root, top).error, 'executor packages must bundle their dependencies (node_modules is not allowed)');
    const nested = writePackage(root, 'phone-y');
    fs.mkdirSync(path.join(nested, 'lib', 'node_modules'), { recursive: true });
    assert.strictEqual(check(root, nested, 'phone-y').error, 'executor packages must bundle their dependencies (node_modules is not allowed)');
    const empty = writePackage(root, 'phone-z');
    fs.mkdirSync(path.join(empty, 'node_modules'));
    assert.strictEqual(check(root, empty, 'phone-z').error, 'executor packages must bundle their dependencies (node_modules is not allowed)');
  });

  it('refuses main reached through a junction that leaves the package', () => {
    const root = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'adapter.js'), ADAPTER);
    const dir = writePackage(root, 'phone-x', { pkg: { main: 'lib/adapter.js' } });
    linkDir(outside, path.join(dir, 'lib'));
    const r = checkPackage({ id: 'phone-x', entry: { packageSha256: PIN_A, config: CONFIG_OK }, dir, roots: [root], vault });
    assert.strictEqual(r.error, 'main resolves outside the package');
  });

  it('refuses an absolute main outside the package, a main inside node_modules and a directory main', () => {
    const root = tmp();
    const outside = path.join(tmp(), 'adapter.js');
    fs.writeFileSync(outside, ADAPTER);
    const abs = writePackage(root, 'phone-x', { pkg: { main: outside } });
    assert.strictEqual(check(root, abs).error, 'main resolves outside the package');
    const nm = writePackage(root, 'phone-y', { pkg: { main: 'node_modules/dep/index.js' } });
    fs.mkdirSync(path.join(nm, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(nm, 'node_modules', 'dep', 'index.js'), ADAPTER);
    assert.strictEqual(check(root, nm, 'phone-y').error, 'main is inside node_modules, which the pin does not cover');
    const asDir = writePackage(root, 'phone-z', { pkg: { main: '.' } });
    assert.strictEqual(check(root, asDir, 'phone-z').error, 'main must name a file in the package');
  });

  it('refuses a package reached through a junction out of the root, and a sibling root with a shared prefix', () => {
    const root = tmp();
    const elsewhere = tmp();
    const real = writePackage(elsewhere, 'phone-x');
    linkDir(real, path.join(root, 'phone-x'));
    assert.match(check(root, path.join(root, 'phone-x')).error, /outside the executor roots/);
    const sibling = `${root}-evil`;
    dirs.push(sibling);
    const dir = writePackage(sibling, 'phone-x');
    assert.match(check(root, dir).error, /outside the executor roots/);
  });

  it('never throws: missing dir, junk roots, a throwing vault, bad ids, bad config and pin types', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    assert.strictEqual(checkPackage({ id: 'phone-x', entry: { packageSha256: PIN_A }, dir: path.join(root, 'nope'), roots: [root], vault }).error, 'no package.json in the package');
    assert.match(checkPackage({ id: 'phone-x', entry: entryFor(dir), dir, roots: [null, 42, {}], vault }).error, /outside the executor roots/);
    const locked = { get: () => { throw new Error('vault is locked: tok-test'); } };
    assert.strictEqual(checkPackage({ id: 'phone-x', entry: entryFor(dir), dir, roots: [root], vault: locked }).error, 'vault key "errands-token" for token could not be read');
    assert.strictEqual(checkPackage({ id: '../x', entry: {}, dir, roots: [root] }).error, 'executor id "../x" is not valid');
    assert.strictEqual(checkPackage({ id: 'phone-x', entry: entryFor(dir, { config: 'x' }), dir, roots: [root], vault }).error, 'config must be an object');
    assert.strictEqual(checkPackage({ id: 'phone-x', entry: entryFor(dir, { packageSha256: 7 }), dir, roots: [root], vault }).error, `pin required: set packageSha256 to ${computePackageSha256(dir)}`);
    assert.strictEqual(checkPackage({ id: 'phone-x', entry: null, dir, roots: [root], vault }).error, `pin required: set packageSha256 to ${computePackageSha256(dir)}`);
  });

  it('refuses a configSchema that could reach the prototype or has an unsupported type', () => {
    const root = tmp();
    const proto = writePackage(root, 'phone-x', { manifest: { configSchema: JSON.parse('{"__proto__": {"type": "string"}}') } });
    assert.strictEqual(checkPackage({ id: 'phone-x', entry: { packageSha256: computePackageSha256(proto), config: {} }, dir: proto, roots: [root], vault }).error, 'configSchema field "__proto__" is not allowed');
    const obj = writePackage(root, 'phone-y', { manifest: { configSchema: { opts: { type: 'object' } } } });
    assert.strictEqual(checkPackage({ id: 'phone-y', entry: { packageSha256: computePackageSha256(obj), config: { opts: {} } }, dir: obj, roots: [root], vault }).error, 'configSchema field "opts" has unsupported type "object"');
  });
});

describe('service root check (M16)', () => {
  it('the default is the real assertAdminOwned bound to adminUid with executor wording', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const calls = [];
    const real = serviceConfig.assertAdminOwned;
    serviceConfig.assertAdminOwned = (...args) => { calls.push(args); throw new Error('refused by stub'); };
    let r;
    try {
      r = checkPackage({ id: 'phone-x', entry: entryFor(dir), dir, roots: [root], vault, isService: true, adminUid: 1234, geteuid: () => 99 });
    } finally {
      serviceConfig.assertAdminOwned = real;
    }
    assert.strictEqual(r.error, 'refused by stub');
    assert.strictEqual(calls.length, 1);
    const [file, geteuid, adminUid, controls] = calls[0];
    assert.strictEqual(file, fs.realpathSync.native(root));
    assert.strictEqual(geteuid(), 99);
    assert.strictEqual(adminUid, 1234);
    assert.deepStrictEqual(controls, { decides: 'which executor packages this service loads', selfGrant: 'swap an executor package' });
    assert.strictEqual(controls, EXECUTOR_ROOT_CONTROLS);
  });

  it('refuses a non-admin root on POSIX with the executor wording', { skip: process.platform === 'win32' ? 'assertAdminOwned is a no-op on win32' : false }, () => {
    const parent = tmp();
    const root = path.join(parent, 'executors');
    fs.mkdirSync(root, { mode: 0o755 });
    const uid = process.geteuid();
    assert.throws(() => makeRootAssert({ adminUid: uid === 0 ? 4242 : 0, geteuid: () => uid })(root), /which executor packages this service loads/);
    assert.doesNotThrow(() => makeRootAssert({ adminUid: uid, geteuid: () => uid })(root));
  });

  it('is a no-op on win32 (the installer ACL protects the root)', { skip: process.platform !== 'win32' ? 'win32 only' : false }, () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    assert.strictEqual(checkPackage({ id: 'phone-x', entry: entryFor(dir), dir, roots: [root], vault, isService: true }).ok, true);
  });
});

describe('secrets stay out of logs and errors', () => {
  it('the resolved config is hidden from JSON and inspect', () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const r = check(root, dir);
    assert.strictEqual(r.config.token, 'tok-test');
    assert.doesNotMatch(JSON.stringify(r), /tok-test/);
    assert.doesNotMatch(util.inspect(r, { depth: 10 }), /tok-test/);
    assert.doesNotMatch(util.inspect({ ...r }, { depth: 10 }), /tok-test/);
  });

  it('redacts secret values from adapter failure reasons', async () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x', { adapter: 'module.exports.createAdapter = (c) => { throw new Error("bad token " + c.token); };' });
    await assert.rejects(loadAdapter(check(root, dir), { id: 'phone-x', entry: {} }), (err) => (
      err instanceof ExecutorUnavailableError && !/tok-test/.test(err.message) && /bad token \[redacted\]/.test(err.reason)
    ));
  });
});

describe('loadAdapter never crashes and loads the checked bytes', () => {
  const REQUIRING = (spec, extra = '') => ADAPTER.replace(
    'module.exports.createAdapter = (config, host) => ({',
    `${extra}const dep = require(${JSON.stringify(spec)});\nmodule.exports.createAdapter = (config, host) => ({\n  dep,`
  );

  it('turns a failed check, a throwing capabilities() and bad capabilities into ExecutorUnavailableError', async () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const failed = checkPackage({ id: 'phone-x', entry: entryFor(dir, { packageSha256: null }), dir, roots: [root], vault });
    await assert.rejects(loadAdapter(failed, { id: 'phone-x', entry: {} }), (err) => err instanceof ExecutorUnavailableError && /pin required/.test(err.reason));
    await assert.rejects(loadAdapter(null, { id: 'phone-x' }), ExecutorUnavailableError);
    const throwing = writePackage(root, 'phone-y', { adapter: ADAPTER.replace('capabilities: () => ({', 'capabilities: () => { throw new Error("nope"); },\n  _unused: () => ({') });
    await assert.rejects(loadAdapter(check(root, throwing, 'phone-y'), { id: 'phone-y', entry: {} }), (err) => err instanceof ExecutorUnavailableError && /capabilities\(\) failed: nope/.test(err.reason));
    const odd = writePackage(root, 'phone-z', { adapter: ADAPTER.replace("capabilities: ['call']", "capabilities: 'call'") });
    await assert.rejects(loadAdapter(check(root, odd, 'phone-z'), { id: 'phone-z', entry: {} }), (err) => err instanceof ExecutorUnavailableError && /capabilities must be an array of strings/.test(err.reason));
    const syntax = writePackage(root, 'phone-w', { adapter: 'module.exports = (' });
    await assert.rejects(loadAdapter(check(root, syntax, 'phone-w'), { id: 'phone-w', entry: {} }), (err) => err instanceof ExecutorUnavailableError && /main failed to load/.test(err.reason));
  });

  it('refuses to load when a file changed after the check', async () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x');
    const checked = check(root, dir);
    fs.appendFileSync(path.join(dir, 'adapter.js'), '\n// swapped\n');
    await assert.rejects(loadAdapter(checked, { id: 'phone-x', entry: {} }), (err) => err instanceof ExecutorUnavailableError && /package changed since it was checked/.test(err.reason));
  });

  it('a re-pinned package loads its new code, not cached modules', async () => {
    const root = tmp();
    const dir = writePackage(root, 'phone-x', { adapter: REQUIRING('./lib.js') });
    fs.writeFileSync(path.join(dir, 'lib.js'), 'module.exports = "v1";');
    assert.strictEqual((await loadAdapter(check(root, dir), { id: 'phone-x', entry: {} })).adapter.dep, 'v1');
    fs.writeFileSync(path.join(dir, 'lib.js'), 'module.exports = "v2";');
    assert.strictEqual((await loadAdapter(check(root, dir), { id: 'phone-x', entry: {} })).adapter.dep, 'v2');
  });
});

describe('makeHostFetch reaches only the declared origins', () => {
  const make = () => {
    const calls = [];
    const fetch = makeHostFetch({
      origins: ['config:baseUrl', 'https://status.example.com', 'https://xn--bcher-kva.example', 'config:missing', 42],
      config: { baseUrl: 'https://errands.example.com/api', token: 'tok-test' },
      requestTimeoutMs: 1000,
      fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true }; }
    });
    return { fetch, calls };
  };

  it('refuses userinfo, look-alike hosts, IP literals, other ports and other schemes', async () => {
    const { fetch, calls } = make();
    const refused = [
      'https://user:pass@errands.example.com/jobs',
      'https://user@errands.example.com/jobs',
      'https://errands.example.com@evil.example.net/jobs',
      'https://errands.example.com.evil.example.net/',
      'https://errands.exаmple.com/',
      'https://errands.example.com:8443/',
      'https://127.0.0.1/', 'http://2130706433/', 'https://[::1]/',
      'http://errands.example.com/', 'ftp://errands.example.com/', 'file:///etc/passwd',
      'data:text/plain,hi', 'javascript:alert(1)', '/relative', 'not a url', ''
    ];
    for (const url of refused) await assert.rejects(fetch(url), /outside this executor's origins|takes an absolute http\(s\) URL/, url);
    await assert.rejects(fetch(new Request('https://errands.example.com/jobs')), /takes an absolute http\(s\) URL/);
    await assert.rejects(fetch({ toString: () => 'https://errands.example.com/jobs' }), /takes an absolute http\(s\) URL/);
    assert.strictEqual(calls.length, 0);
  });

  it('never echoes credentials or query strings from a refused URL', async () => {
    const { fetch } = make();
    await assert.rejects(fetch('https://user:hunter2@evil.example.net/?token=tok-test'), (err) => !/hunter2|tok-test/.test(err.message));
    await assert.rejects(fetch('https://user:hunter2@errands.example.com/?token=tok-test'), (err) => !/hunter2|tok-test/.test(err.message));
  });

  it('accepts IDN origins in their normalized form and URL objects', async () => {
    const { fetch, calls } = make();
    await fetch('https://bücher.example/x');
    await fetch(new URL('https://ERRANDS.example.com:443/jobs'));
    assert.deepStrictEqual(calls.map((c) => c.url), ['https://xn--bcher-kva.example/x', 'https://errands.example.com/jobs']);
  });

  it('forces redirect: error and passes only plain request options', async () => {
    const { fetch, calls } = make();
    await fetch('https://errands.example.com/jobs', { method: 'POST', headers: { a: 'b' }, body: 'x', redirect: 'follow', dispatcher: { proxy: 1 } });
    const { init } = calls[0];
    assert.strictEqual(init.redirect, 'error');
    assert.strictEqual(init.method, 'POST');
    assert.deepStrictEqual(init.headers, { a: 'b' });
    assert.strictEqual(init.body, 'x');
    assert.strictEqual('dispatcher' in init, false);
  });

  it('a redirect fails through the real fetch', async () => {
    const http = require('http');
    const server = http.createServer((req, res) => { res.writeHead(302, { location: 'http://127.0.0.2:9/' }); res.end(); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const fetch = makeHostFetch({ origins: [base], requestTimeoutMs: 2000 });
      await assert.rejects(fetch(`${base}/jobs`), TypeError);
    } finally {
      server.close();
    }
  });

  it('aborts at requestTimeoutMs', async () => {
    const fetch = makeHostFetch({
      origins: ['https://errands.example.com'],
      requestTimeoutMs: 20,
      fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))
    });
    await assert.rejects(fetch('https://errands.example.com/slow'), /timeout|aborted/i);
  });
});
