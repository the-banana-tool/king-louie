// tests/cases-case-guard.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fx = require('./helpers/executor-fixtures');
const { caseToolGuard, configureCaseGuard, BROWSER_ALLOWED, BROWSER_REFUSAL } = require('../src/cases/executors/case-guard');
const browserTool = require('../src/tools/builtin/browser-tool');

after(() => {
  configureCaseGuard({});
  fx.cleanup();
});

const ENUMS = {
  BrowserSession: require('../src/tools/builtin/browser-session-tool').parameters.properties.action.enum,
  BrowserPage: require('../src/tools/builtin/browser-page-tool').parameters.properties.action.enum,
  BrowserExtract: require('../src/tools/builtin/browser-extract-tool').parameters.properties.action.enum,
  Browser: browserTool.actionNames
};

async function setup() {
  const env = fx.setupExecutors();
  const meta = await fx.activeCase(env.runtime);
  env.runtime.ledger(meta.id).assert({
    stmt: 'Lowest acceptable price', subject: 'lot', attr: 'floor', value: 98000, unit: 'USD', provenance: 'user', category: 'financial', source: { kind: 'question', ref: 'q-0099' }
  });
  configureCaseGuard({ getCaseRuntime: () => env.runtime, dataDir: env.dataDir });
  return { env, meta, ctx: { caseContext: { caseId: meta.id, runtime: env.runtime, dir: meta.dir }, workingDirectory: meta.dir } };
}

describe('browser allow-list', () => {
  it('refuses every browser action that types, runs script, handles credentials or storage', async () => {
    const { ctx } = await setup();
    for (const [tool, actions] of Object.entries(ENUMS)) {
      for (const action of actions) {
        const r = caseToolGuard(tool, { action, url: 'https://permits.example.com' }, ctx);
        if (BROWSER_ALLOWED[tool].includes(action)) assert.strictEqual(r, null, `${tool}.${action} should pass`);
        else assert.deepStrictEqual(r, { success: false, error: BROWSER_REFUSAL }, `${tool}.${action} should be refused`);
      }
    }
    for (const refused of ['fill', 'type', 'press', 'evaluate', 'set_input_files', 'keyboard_type']) {
      assert.ok(!BROWSER_ALLOWED.BrowserPage.includes(refused), refused);
    }
    for (const refused of ['fill_credentials', 'save_credentials', 'login', 'signup', 'fill_payment', 'handle_dialog', 'load_storage_state', 'get_cookies']) {
      assert.ok(!BROWSER_ALLOWED.Browser.includes(refused), refused);
    }
  });

  it('gates the url of navigate and open_tab in query mode', async () => {
    const { ctx } = await setup();
    assert.strictEqual(caseToolGuard('BrowserPage', { action: 'navigate', url: 'https://permits.example.com/apply' }, ctx), null);
    const r = caseToolGuard('BrowserSession', { action: 'open_tab', url: 'https://offers.example.com/?min=98000' }, ctx);
    assert.strictEqual(r.success, false);
    assert.match(r.error, /^BrowserSession would send case data that may not leave: "98000" \(non-disclosable f-0001\)/);
    assert.strictEqual(caseToolGuard('Browser', { action: 'navigate', url: 'https://offers.example.com/?min=98,000' }, ctx).success, false);
  });
});

describe('web tools and data-dir writes', () => {
  it('gates WebFetch.url and WebSearch.query', async () => {
    const { ctx } = await setup();
    assert.strictEqual(caseToolGuard('WebSearch', { query: 'county permit fees' }, ctx), null);
    assert.strictEqual(caseToolGuard('WebSearch', { query: 'lots selling above 98000' }, ctx).success, false);
    assert.strictEqual(caseToolGuard('WebFetch', { url: 'https://records.example.org/?p=98000' }, ctx).success, false);
  });

  it('refuses writes into ops memory and the executors folder', async () => {
    const { env, ctx } = await setup();
    const refused = caseToolGuard('Write', { file_path: path.join(env.dataDir, 'ops-memory.jsonl'), content: 'x' }, ctx);
    assert.match(refused.error, /written only by King Louie/);
    assert.strictEqual(caseToolGuard('Edit', { file_path: path.join(env.dataDir, 'executors', 'usage.json') }, ctx).success, false);
    assert.strictEqual(caseToolGuard('MultiEdit', { edits: [{ file_path: path.join(env.dataDir, 'executors', 'phone-agent', 'adapter.js') }] }, ctx).success, false);
    assert.strictEqual(caseToolGuard('Write', { file_path: path.join(env.dataDir, 'notes.md') }, ctx), null);
  });

  it('is off outside cases, and uses the configured runtime for a child\'s guardContext', async () => {
    const { meta } = await setup();
    assert.strictEqual(caseToolGuard('BrowserPage', { action: 'fill', selector: '#a', text: 'x' }, {}), null);
    assert.strictEqual(caseToolGuard('WebSearch', { query: 'above 98000' }, { guardContext: { caseId: meta.id } }).success, false);
    configureCaseGuard({});
    assert.match(caseToolGuard('WebSearch', { query: 'permit fees' }, { guardContext: { caseId: meta.id } }).error, /not available to check/);
  });
});
