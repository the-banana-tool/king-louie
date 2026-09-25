// tests/desktop-bridge-scope.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDesktopScope } = require('../src/desktop-bridge/desktop-scope');
const { checkPath } = require('../src/desktop-bridge/check-path');
const { addSink } = require('../src/logging');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-scope-')); dirs.push(d); return d; };

// A real, syntactically valid absolute directory for the current platform,
// anchored at the current drive's root on win32 (never a literal machine
// path — just its own root) and at "/" on POSIX. Needed once normalizeDirectory
// started resolving its input: a bare POSIX-style "/home/..." literal would
// otherwise get rewritten with the current drive letter on win32, breaking
// an exact-string assertion that predates that change.
const abs = (...parts) => path.join(path.parse(process.cwd()).root, ...parts);
// Two fixed example directories reused across this file. Once
// normalizeDirectory started actually resolving its input (fix round 1),
// every path that flows through addDirectory/setSettings/getSettings needs
// to already be in the form normalizeDirectory would produce, or an
// exact-string assertion (or the own.includes(normalized) dedup check
// inside setSettings) breaks on win32.
const SERVICE_ONLY = abs('srv', 'service-only');
const DATA_EXAMPLE = abs('data', 'example');

function fakeContext() {
  let settings = { allowedDirectories: [SERVICE_ONLY], inference: { activeTier: 'standard' } };
  let rules = [];
  return {
    getSettings: () => JSON.parse(JSON.stringify(settings)),
    setSettings: (next) => { settings = JSON.parse(JSON.stringify(next)); },
    getPermissionRules: () => rules,
    addPermissionRule: (rule) => { rules = rules.filter((r) => !(r.tool === rule.tool && r.pattern === rule.pattern && r.action === rule.action)); rules.push({ ...rule }); },
    removePermissionRule: (tool, pattern, action) => { rules = rules.filter((r) => !(r.tool === tool && (r.pattern || '*') === (pattern || '*') && r.action === action)); },
    peek: () => ({ settings, rules })
  };
}

describe('desktop-scoped settings', () => {
  it('adds desktop directories to what marked runs read, never to the service settings', () => {
    const dataDir = tmp();
    const context = fakeContext();
    const scope = createDesktopScope({ dataDir, context });
    const projects = abs('home', 'example', 'projects');
    assert.deepStrictEqual(scope.addDirectory(projects), [SERVICE_ONLY, projects]);
    assert.deepStrictEqual(scope.getSettings().allowedDirectories, [SERVICE_ONLY, projects]);
    assert.deepStrictEqual(context.peek().settings.allowedDirectories, [SERVICE_ONLY]);
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop', 'allowed-directories.json'), 'utf8'));
    assert.deepStrictEqual(file, { v: 1, directories: [projects] });
  });

  it('normalizes a directory so a different spelling of the same one dedups', () => {
    const dataDir = tmp();
    const scope = createDesktopScope({ dataDir, context: fakeContext() });
    const projects = abs('home', 'example', 'projects');
    assert.deepStrictEqual(scope.addDirectory(`${projects}${path.sep}`), [SERVICE_ONLY, projects], 'a trailing separator is stripped');
    assert.deepStrictEqual(scope.addDirectory(`${projects}${path.sep}sub${path.sep}..`), [SERVICE_ONLY, projects], "a '..' segment resolves away, landing back on the same entry");
    if (process.platform === 'win32') {
      const upper = `${projects[0].toUpperCase()}${projects.slice(1)}`;
      const lower = `${projects[0].toLowerCase()}${projects.slice(1)}`;
      assert.deepStrictEqual(scope.addDirectory(upper === projects ? lower : upper), [SERVICE_ONLY, projects], 'the drive letter case folds, so it dedups regardless of how it was typed');
    }
    assert.deepStrictEqual(scope.listDirectories(), [projects], 'still exactly one entry after every re-spelling');
  });

  it('throws INVALID_DIRECTORY for a relative or empty path', () => {
    const scope = createDesktopScope({ dataDir: tmp(), context: fakeContext() });
    for (const bad of ['relative/dir', '', '   ', null, undefined, 42]) {
      assert.throws(() => scope.addDirectory(bad), (err) => err.code === 'INVALID_DIRECTORY');
    }
  });

  it('treats a malformed or unknown-version file as empty, but warns about it', () => {
    const dataDir = tmp();
    const scope = createDesktopScope({ dataDir, context: fakeContext() });
    const file = path.join(dataDir, 'desktop', 'allowed-directories.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });

    fs.writeFileSync(file, '{not json');
    let warnings = [];
    let remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    try {
      assert.deepStrictEqual(scope.listDirectories(), [], 'malformed JSON fails closed');
    } finally { remove(); }
    assert.ok(warnings.some((m) => m.includes('allowed-directories.json')), 'warned about the malformed file');

    fs.writeFileSync(file, JSON.stringify({ v: 2, directories: [DATA_EXAMPLE] }));
    warnings = [];
    remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    try {
      assert.deepStrictEqual(scope.listDirectories(), [], 'an unrecognized version fails closed too');
    } finally { remove(); }
    assert.ok(warnings.some((m) => m.includes('allowed-directories.json')), 'warned about the unknown version');

    // A file this scope itself wrote (v: 1) is read normally, no warning.
    // (Starting from no file at all: addDirectory's own pre-write read of
    // the still-v:2 file above would otherwise warn a second time.)
    fs.rmSync(file, { force: true });
    warnings = [];
    remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    try {
      scope.addDirectory(DATA_EXAMPLE);
      assert.deepStrictEqual(scope.listDirectories(), [DATA_EXAMPLE]);
    } finally { remove(); }
    assert.deepStrictEqual(warnings, []);
  });

  it('diverts allowedDirectories writes and passes every other key through', () => {
    const dataDir = tmp();
    const context = fakeContext();
    const scope = createDesktopScope({ dataDir, context });
    const next = scope.getSettings();
    next.allowedDirectories = [SERVICE_ONLY, DATA_EXAMPLE];
    next.inference = { activeTier: 'smart' };
    scope.setSettings(next);
    assert.deepStrictEqual(context.peek().settings, { allowedDirectories: [SERVICE_ONLY], inference: { activeTier: 'smart' } });
    assert.deepStrictEqual(scope.listDirectories(), [DATA_EXAMPLE]);
    // The desktop cannot remove a service directory: it stays.
    scope.setSettings({ ...scope.getSettings(), allowedDirectories: [] });
    assert.deepStrictEqual(context.peek().settings.allowedDirectories, [SERVICE_ONLY]);
    assert.deepStrictEqual(scope.listDirectories(), []);
  });

  it('records rules the desktop adds and refuses to remove any other', () => {
    const dataDir = tmp();
    const context = fakeContext();
    context.addPermissionRule({ tool: 'Bash', pattern: 'rm *', action: 'deny', source: 'service' });
    const scope = createDesktopScope({ dataDir, context });
    scope.addPermissionRule({ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'approval-dialog' });
    assert.deepStrictEqual(scope.listRules(), [{ tool: 'Bash', pattern: 'git *', action: 'allow' }]);
    assert.throws(() => scope.removePermissionRule('Bash', 'rm *', 'deny'),
      (err) => err.code === 'RULE_NOT_DESKTOP' && err.message === 'This rule was set on the service and can only be removed there.');
    assert.ok(context.peek().rules.some((r) => r.pattern === 'rm *'), 'the deny rule is still there');
    scope.removePermissionRule('Bash', 'git *', 'allow');
    assert.deepStrictEqual(scope.listRules(), []);
    assert.ok(!context.peek().rules.some((r) => r.pattern === 'git *'));
  });

  // Fix round 1, C1: the desktop could lift a service deny rule by re-adding
  // the exact same (tool, pattern, action) key through the approval dialog
  // — context.addPermissionRule dedups by key and replaces whatever rule
  // held it, service-sourced or not — and then removing it, since
  // desktop-scope would otherwise record itself as owning that key. Neither
  // step may succeed: the "re-add" must be a no-op that leaves the service
  // rule exactly as it was, so the desktop never actually comes to own the
  // key, so the follow-up remove still refuses.
  it('cannot lift a service rule by re-adding then removing the same key', () => {
    const dataDir = tmp();
    const context = fakeContext();
    context.addPermissionRule({ tool: 'Bash', pattern: 'rm *', action: 'deny', source: 'service' });
    const before = context.peek().rules.find((r) => r.pattern === 'rm *');
    const scope = createDesktopScope({ dataDir, context });

    // Step 1: the desktop "re-adds" the service's own rule (exactly what an
    // approval-dialog ruleAction: 'deny' response sends).
    scope.addPermissionRule({ tool: 'Bash', pattern: 'rm *', action: 'deny', source: 'approval-dialog' });
    assert.deepStrictEqual(scope.listRules(), [], 'the desktop does not record itself as owning it');
    assert.deepStrictEqual(context.peek().rules.find((r) => r.pattern === 'rm *'), before, 'the service rule (and its source) is untouched');

    // Step 2: the desktop tries to remove what it just "added".
    assert.throws(() => scope.removePermissionRule('Bash', 'rm *', 'deny'),
      (err) => err.code === 'RULE_NOT_DESKTOP');
    assert.deepStrictEqual(context.peek().rules.find((r) => r.pattern === 'rm *'), before, 'still there, still the service\'s');
  });

  it('removePermissionRule refuses a key the desktop owns locally once a service rule has reclaimed it', () => {
    const dataDir = tmp();
    const context = fakeContext();
    const scope = createDesktopScope({ dataDir, context });
    scope.addPermissionRule({ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'approval-dialog' });
    assert.deepStrictEqual(scope.listRules(), [{ tool: 'Bash', pattern: 'git *', action: 'allow' }]);
    // The service independently sets a rule with the same key (replacing
    // the desktop's one at the context level, the way addPermissionRule
    // always dedups) — the desktop's local record now disagrees with reality.
    context.addPermissionRule({ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'service' });
    assert.throws(() => scope.removePermissionRule('Bash', 'git *', 'allow'),
      (err) => err.code === 'RULE_NOT_DESKTOP');
    assert.ok(context.peek().rules.some((r) => r.pattern === 'git *' && r.source === 'service'));
  });

  // Task 8 carry-over (a): addPermissionRule used to skip the existing-rule
  // check entirely once rules.json already recorded the desktop as owning a
  // key, so a stale local record could overwrite a rule the service had
  // since reclaimed for that same (tool, pattern, action). The check must
  // run regardless of ownedByDesktop whenever the context's current rule for
  // that key is not origin: 'desktop' (a service add drops the origin).
  it('addPermissionRule refuses to take back a key the service has reclaimed, even though the desktop\'s own record still says it owns it', () => {
    const dataDir = tmp();
    const context = fakeContext();
    const scope = createDesktopScope({ dataDir, context });
    scope.addPermissionRule({ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'approval-dialog' });
    assert.deepStrictEqual(scope.listRules(), [{ tool: 'Bash', pattern: 'git *', action: 'allow' }], 'the desktop owns the key locally');
    // The service independently reclaims the same key.
    context.addPermissionRule({ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'service' });
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    try {
      scope.addPermissionRule({ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'approval-dialog' });
    } finally { remove(); }
    assert.ok(context.peek().rules.some((r) => r.pattern === 'git *' && r.source === 'service'), 'the service rule is untouched');
    assert.ok(warnings.some((m) => m.includes('reclaimed')), 'logged the refusal');
  });

  // M4: setSettings used to pass allowedDirectories through with only a
  // typeof/non-empty check, so a relative path or garbage value could land
  // in the desktop's own allow-list unnormalized (and un-deduped against a
  // differently-spelled entry already there).
  it('setSettings normalizes incoming directories and drops invalid ones, logging it', () => {
    const dataDir = tmp();
    const scope = createDesktopScope({ dataDir, context: fakeContext() });
    const projects = abs('home', 'example', 'projects');
    const warnings = [];
    const remove = addSink((r) => { if (r.level === 'warn') warnings.push(r.message); });
    let next;
    try {
      next = scope.getSettings();
      next.allowedDirectories = [`${projects}${path.sep}`, 'relative/dir', '', null, 42, projects];
      scope.setSettings(next);
    } finally { remove(); }
    assert.deepStrictEqual(scope.listDirectories(), [projects], 'normalized, deduped, invalid entries dropped');
    assert.strictEqual(warnings.length, 4, 'warned about each invalid entry (relative/dir, empty string, null, 42)');
  });

  // Task 8 carry-over (b): setSettings compared a normalized incoming entry
  // against `own` (the service's directories) exactly as the service last
  // wrote them, unnormalized. A re-spelling of a service directory (trailing
  // separator, different drive-letter case) that normalizeDirectory would
  // fold to the same string as the service's own entry did not match it, so
  // it landed in the desktop-only list too — a duplicate the service never
  // actually widened past its own real directory.
  it('setSettings normalizes the service\'s own directories too, so a re-spelling of one is not duplicated into the desktop list', () => {
    const dataDir = tmp();
    const context = fakeContext();
    context.setSettings({ ...context.getSettings(), allowedDirectories: [`${SERVICE_ONLY}${path.sep}`] });
    const scope = createDesktopScope({ dataDir, context });
    const next = scope.getSettings();
    next.allowedDirectories = [SERVICE_ONLY];
    scope.setSettings(next);
    assert.deepStrictEqual(scope.listDirectories(), [], 'the normalized spelling of the service directory is not duplicated into the desktop list');
    assert.deepStrictEqual(context.peek().settings.allowedDirectories, [`${SERVICE_ONLY}${path.sep}`], 'the service list is left exactly as it was');
  });

  it('reports every path it writes', () => {
    const dataDir = tmp();
    const written = [];
    const scope = createDesktopScope({ dataDir, context: fakeContext(), onPathWritten: (p) => written.push(p) });
    scope.addDirectory(DATA_EXAMPLE);
    assert.ok(written.includes(path.join(dataDir, 'desktop')));
    assert.ok(written.includes(path.join(dataDir, 'desktop', 'allowed-directories.json')));
  });
});

describe('checkPath', () => {
  it('reads and writes a directory by doing it, leaving no probe behind', async () => {
    const dir = tmp();
    assert.deepStrictEqual(await checkPath(dir), { ok: true, exists: true, isDirectory: true, readable: true, writable: true });
    assert.deepStrictEqual(fs.readdirSync(dir), []);
  });

  it('checks a file, and reports a missing or relative path as unreadable', async () => {
    const file = path.join(tmp(), 'notes.txt');
    fs.writeFileSync(file, 'x');
    assert.deepStrictEqual(await checkPath(file), { ok: true, exists: true, isDirectory: false, readable: true, writable: true });
    assert.deepStrictEqual(await checkPath(path.join(tmp(), 'missing')), { ok: true, exists: false, isDirectory: false, readable: false, writable: false });
    assert.strictEqual((await checkPath('relative/dir')).readable, false);
  });

  it('reports a read-only directory as not writable', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'POSIX, non-root only' : false }, async () => {
    const dir = tmp();
    fs.chmodSync(dir, 0o500);
    try {
      const out = await checkPath(dir);
      assert.strictEqual(out.readable, true);
      assert.strictEqual(out.writable, false);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });
});
