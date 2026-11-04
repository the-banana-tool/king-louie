const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  APP_CATALOG,
  discoverApps,
  findByCapability,
  findById,
  buildAppContextSection,
  resetDiscoveryCache,
  comClassRegisteredArgs
} = require('../src/execution/app-discovery');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isCommandAvailable } = require('../src/execution/runtime-environment');

// Discovery over the real catalog probes the machine; the tests stub the
// per-app check so the suite never touches installed software.
function stubDetect(app) {
  return Promise.resolve(['vscode', 'node'].includes(app.id) ? { found: true, launchCmd: app.id } : { found: false });
}

// ── catalog structure ────────────────────────────────────────────────────────

describe('APP_CATALOG', () => {
  it('has entries with required fields', () => {
    for (const app of APP_CATALOG) {
      assert.ok(app.id, `app must have an id`);
      assert.ok(app.description, `${app.id} must have a description`);
      assert.ok(Array.isArray(app.capabilities), `${app.id} must have capabilities array`);
      assert.ok(app.capabilities.length > 0, `${app.id} must have at least one capability`);
      assert.ok(app.category, `${app.id} must have a category`);
    }
  });

  it('has unique ids', () => {
    const ids = APP_CATALOG.map((a) => a.id);
    const unique = new Set(ids);
    assert.strictEqual(unique.size, ids.length, 'All app ids must be unique');
  });

  it('has names array on non-webOnly entries', () => {
    for (const app of APP_CATALOG) {
      if (!app.webOnly) {
        assert.ok(Array.isArray(app.names), `${app.id} must have a names array`);
      }
    }
  });

  it('covers major categories', () => {
    const categories = new Set(APP_CATALOG.map((a) => a.category));
    assert.ok(categories.has('office'), 'should have office apps');
    assert.ok(categories.has('development'), 'should have development apps');
    assert.ok(categories.has('browser'), 'should have browser apps');
  });
});

// ── discovery ────────────────────────────────────────────────────────────────

describe('discoverApps()', () => {
  it('returns an array of discovered apps', async () => {
    resetDiscoveryCache();
    const apps = await discoverApps({ detect: stubDetect });
    assert.ok(Array.isArray(apps));
    // Should find at least something on any dev machine
    // (node, git are CLI tools not desktop apps, but we might find vscode, terminal, etc.)
  });

  it('discovered apps have required fields', async () => {
    const apps = await discoverApps({ detect: stubDetect });
    for (const app of apps) {
      assert.ok(app.id, 'discovered app must have id');
      assert.ok(app.description, `${app.id} must have description`);
      assert.ok(Array.isArray(app.capabilities), `${app.id} must have capabilities`);
      assert.ok(app.category, `${app.id} must have category`);
      assert.ok(app.launchCmd, `${app.id} must have launchCmd`);
    }
  });

  it('uses cache on subsequent calls', async () => {
    // apps1 is already cached from the previous test
    const apps1 = await discoverApps({ detect: stubDetect });
    const apps2 = await discoverApps({ detect: stubDetect });
    assert.strictEqual(apps1, apps2, 'should return same cached reference');
  });

  it('bypasses cache with force option', async () => {
    // Use a tiny custom catalog so force re-scan is fast
    const tinyCatalog = [
      { id: 'node', names: ['node'], capabilities: ['runtime'], category: 'dev', description: 'Node' }
    ];
    const apps1 = await discoverApps({ catalog: tinyCatalog, force: true, detect: stubDetect });
    const apps2 = await discoverApps({ catalog: tinyCatalog, force: true, detect: stubDetect });
    assert.ok(Array.isArray(apps2));
    assert.notStrictEqual(apps1, apps2, 'force should return a new array');
  });

  it('skips webOnly apps', async () => {
    const apps = await discoverApps({ detect: stubDetect });
    const webOnly = apps.filter((a) => {
      const catalogEntry = APP_CATALOG.find((c) => c.id === a.id);
      return catalogEntry?.webOnly;
    });
    assert.strictEqual(webOnly.length, 0, 'should not include webOnly apps');
  });

  it('accepts custom catalog', async () => {
    const customCatalog = [
      { id: 'node', names: ['node'], capabilities: ['runtime'], category: 'development', description: 'Node.js' }
    ];
    resetDiscoveryCache();
    const apps = await discoverApps({ catalog: customCatalog, force: true, detect: stubDetect });
    // the stub reports node as installed
    assert.ok(apps.some((a) => a.id === 'node'), 'should find node');
  });
});

// ── Windows COM check ────────────────────────────────────────────────────────

describe('comClassRegisteredArgs()', () => {
  it('reads the registry and never instantiates the COM class', () => {
    assert.deepStrictEqual(comClassRegisteredArgs('Word.Application'), ['query', 'HKCR\\Word.Application\\CLSID', '/ve']);
  });

  it('refuses a ProgID that is not a plain dotted name', () => {
    assert.strictEqual(comClassRegisteredArgs('Word.Application" & calc'), null);
    assert.strictEqual(comClassRegisteredArgs(''), null);
    assert.strictEqual(comClassRegisteredArgs(undefined), null);
  });
});

// ── query helpers ────────────────────────────────────────────────────────────

describe('findByCapability()', () => {
  const mockApps = [
    { id: 'excel', capabilities: ['spreadsheet', 'csv'], category: 'office', description: 'Excel' },
    { id: 'vscode', capabilities: ['code-editor', 'text-editor'], category: 'dev', description: 'VS Code' },
    { id: 'calc', capabilities: ['spreadsheet'], category: 'office', description: 'LibreOffice Calc' }
  ];

  it('finds apps matching a capability', () => {
    const results = findByCapability('spreadsheet', mockApps);
    assert.strictEqual(results.length, 2);
    assert.ok(results.some((a) => a.id === 'excel'));
    assert.ok(results.some((a) => a.id === 'calc'));
  });

  it('matches partial capability strings', () => {
    const results = findByCapability('editor', mockApps);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, 'vscode');
  });

  it('is case-insensitive', () => {
    const results = findByCapability('SPREADSHEET', mockApps);
    assert.strictEqual(results.length, 2);
  });

  it('returns empty array for no matches', () => {
    const results = findByCapability('video-editing', mockApps);
    assert.strictEqual(results.length, 0);
  });
});

describe('findById()', () => {
  const mockApps = [
    { id: 'excel', description: 'Excel' },
    { id: 'vscode', description: 'VS Code' }
  ];

  it('finds app by id', () => {
    const app = findById('excel', mockApps);
    assert.strictEqual(app.id, 'excel');
  });

  it('returns null for unknown id', () => {
    const app = findById('nonexistent', mockApps);
    assert.strictEqual(app, null);
  });
});

// ── context section ──────────────────────────────────────────────────────────

describe('buildAppContextSection()', () => {
  it('returns empty string when no apps discovered', () => {
    assert.strictEqual(buildAppContextSection([]), '');
  });

  it('builds formatted section with categories', () => {
    const apps = [
      { id: 'excel', description: 'Microsoft Excel', capabilities: ['spreadsheet'], category: 'office', launchCmd: 'excel' },
      { id: 'vscode', description: 'VS Code', capabilities: ['code-editor'], category: 'development', launchCmd: 'code' }
    ];
    const section = buildAppContextSection(apps);
    assert.ok(section.includes('Installed local applications'));
    assert.ok(section.includes('office:'));
    assert.ok(section.includes('development:'));
    assert.ok(section.includes('excel'));
    assert.ok(section.includes('vscode'));
    assert.ok(section.includes('[launch: excel]'));
    assert.ok(section.includes('prefer these over generating content'));
  });

  it('groups apps by category', () => {
    const apps = [
      { id: 'a', description: 'A', capabilities: ['x'], category: 'cat1', launchCmd: 'a' },
      { id: 'b', description: 'B', capabilities: ['y'], category: 'cat1', launchCmd: 'b' },
      { id: 'c', description: 'C', capabilities: ['z'], category: 'cat2', launchCmd: 'c' }
    ];
    const section = buildAppContextSection(apps);
    assert.ok(section.includes('cat1:'));
    assert.ok(section.includes('cat2:'));
  });
});

// The service's working directory is <dataDir>/workspace, where the model can
// write. A lookup at start must never run, or report, anything from there. An
// agent shell sets NoDefaultCurrentDirectoryInExePath, which hides this on
// Windows, so the test takes it out.
describe('nothing from the working directory', () => {
  const cwd = process.cwd();
  const savedNoCwd = process.env.NoDefaultCurrentDirectoryInExePath;
  const savedPath = process.env.PATH;
  let dir;
  const beforeEach_ = () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-discovery-'));
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    process.chdir(dir);
    resetDiscoveryCache();
  };
  const afterEach_ = () => {
    process.chdir(cwd);
    if (savedNoCwd !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = savedNoCwd;
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
    resetDiscoveryCache();
  };
  const entry = (extra) => ({ id: 'kl-planted-tool', names: ['kl-planted-tool'], capabilities: ['x'], category: 'x', description: 'x', ...extra });

  it('Windows: a planted where.cmd, reg.cmd, powershell.cmd or tool does not run or reach the result', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
    beforeEach_();
    try {
      for (const name of ['where', 'reg', 'powershell', 'kl-planted-tool']) {
        fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\necho ran> "%~dp0${name}.ran"\r\necho ${path.join(dir, name)}.cmd\r\n`);
      }
      const apps = await discoverApps({ force: true, catalog: [entry({ winReg: 'Kl.Planted' })] });
      assert.deepStrictEqual(apps, [], 'nothing from the cwd is found');
      assert.strictEqual(await isCommandAvailable('kl-planted-tool'), false);
      assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.ran')), [], 'nothing planted ran');
    } finally {
      afterEach_();
    }
  });

  it('Windows: the real programs still answer', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
    beforeEach_();
    try {
      const apps = await discoverApps({ force: true, catalog: [
        entry({ id: 'cmd', names: ['cmd'] }),
        entry({ id: 'kl-com', names: [], winReg: 'Scripting.FileSystemObject' })
      ] });
      assert.match(apps.find((a) => a.id === 'cmd').launchCmd, /cmd\.exe$/i);
      assert.ok(apps.find((a) => a.id === 'kl-com'), 'a registered COM class is found');
      assert.strictEqual(await isCommandAvailable('cmd'), true);
    } finally {
      afterEach_();
    }
  });

  it('POSIX: a PATH that names the cwd does not find a tool planted there', { skip: process.platform === 'win32' && 'POSIX only' }, async () => {
    beforeEach_();
    try {
      const tool = path.join(dir, 'kl-planted-tool');
      fs.writeFileSync(tool, '#!/bin/sh\ntouch "$(dirname "$0")/tool.ran"\n', { mode: 0o755 });
      process.env.PATH = `.:${process.env.PATH}`;
      const apps = await discoverApps({ force: true, catalog: [entry()] });
      assert.deepStrictEqual(apps, []);
      assert.strictEqual(await isCommandAvailable('kl-planted-tool'), false);
      assert.strictEqual(fs.existsSync(path.join(dir, 'tool.ran')), false);
    } finally {
      afterEach_();
    }
  });
});
