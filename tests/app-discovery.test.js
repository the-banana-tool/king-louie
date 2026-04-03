const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  APP_CATALOG,
  discoverApps,
  findByCapability,
  findById,
  buildAppContextSection,
  resetDiscoveryCache
} = require('../src/execution/app-discovery');

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
    const apps = await discoverApps();
    assert.ok(Array.isArray(apps));
    // Should find at least something on any dev machine
    // (node, git are CLI tools not desktop apps, but we might find vscode, terminal, etc.)
  });

  it('discovered apps have required fields', async () => {
    const apps = await discoverApps();
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
    const apps1 = await discoverApps();
    const apps2 = await discoverApps();
    assert.strictEqual(apps1, apps2, 'should return same cached reference');
  });

  it('bypasses cache with force option', async () => {
    // Use a tiny custom catalog so force re-scan is fast
    const tinyCatalog = [
      { id: 'node', names: ['node'], capabilities: ['runtime'], category: 'dev', description: 'Node' }
    ];
    const apps1 = await discoverApps({ catalog: tinyCatalog, force: true });
    const apps2 = await discoverApps({ catalog: tinyCatalog, force: true });
    assert.ok(Array.isArray(apps2));
    assert.notStrictEqual(apps1, apps2, 'force should return a new array');
  });

  it('skips webOnly apps', async () => {
    const apps = await discoverApps();
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
    const apps = await discoverApps({ catalog: customCatalog, force: true });
    // node should be found on any machine running these tests
    assert.ok(apps.some((a) => a.id === 'node'), 'should find node');
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
