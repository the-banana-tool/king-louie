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

function fakeContext() {
  let settings = { allowedDirectories: ['/srv/service-only'], inference: { activeTier: 'standard' } };
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
    assert.deepStrictEqual(scope.addDirectory(projects), ['/srv/service-only', projects]);
    assert.deepStrictEqual(scope.getSettings().allowedDirectories, ['/srv/service-only', projects]);
    assert.deepStrictEqual(context.peek().settings.allowedDirectories, ['/srv/service-only']);
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop', 'allowed-directories.json'), 'utf8'));
    assert.deepStrictEqual(file, { v: 1, directories: [projects] });
  });

  it('normalizes a directory so a different spelling of the same one dedups', () => {
    const dataDir = tmp();
    const scope = createDesktopScope({ dataDir, context: fakeContext() });
    const projects = abs('home', 'example', 'projects');
    assert.deepStrictEqual(scope.addDirectory(`${projects}${path.sep}`), ['/srv/service-only', projects], 'a trailing separator is stripped');
    assert.deepStrictEqual(scope.addDirectory(`${projects}${path.sep}sub${path.sep}..`), ['/srv/service-only', projects], "a '..' segment resolves away, landing back on the same entry");
    if (process.platform === 'win32') {
      const upper = `${projects[0].toUpperCase()}${projects.slice(1)}`;
      const lower = `${projects[0].toLowerCase()}${projects.slice(1)}`;
      assert.deepStrictEqual(scope.addDirectory(upper === projects ? lower : upper), ['/srv/service-only', projects], 'the drive letter case folds, so it dedups regardless of how it was typed');
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

    fs.writeFileSync(file, JSON.stringify({ v: 2, directories: [abs('data', 'example')] }));
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
      scope.addDirectory(abs('data', 'example'));
      assert.deepStrictEqual(scope.listDirectories(), [abs('data', 'example')]);
    } finally { remove(); }
    assert.deepStrictEqual(warnings, []);
  });

  it('diverts allowedDirectories writes and passes every other key through', () => {
    const dataDir = tmp();
    const context = fakeContext();
    const scope = createDesktopScope({ dataDir, context });
    const next = scope.getSettings();
    next.allowedDirectories = ['/srv/service-only', '/data/example'];
    next.inference = { activeTier: 'smart' };
    scope.setSettings(next);
    assert.deepStrictEqual(context.peek().settings, { allowedDirectories: ['/srv/service-only'], inference: { activeTier: 'smart' } });
    assert.deepStrictEqual(scope.listDirectories(), ['/data/example']);
    // The desktop cannot remove a service directory: it stays.
    scope.setSettings({ ...scope.getSettings(), allowedDirectories: [] });
    assert.deepStrictEqual(context.peek().settings.allowedDirectories, ['/srv/service-only']);
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

  it('reports every path it writes', () => {
    const dataDir = tmp();
    const written = [];
    const scope = createDesktopScope({ dataDir, context: fakeContext(), onPathWritten: (p) => written.push(p) });
    scope.addDirectory('/data/example');
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
