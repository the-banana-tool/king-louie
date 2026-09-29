// tests/cases-case-guard.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
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
        const r = caseToolGuard(tool, { action, url: 'https://permits.example.com', profile: 'kl-cases' }, ctx);
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
    // Final review minor 8: the settings store holds executors.entries and pins.
    // Case-folded only where the file system folds case (Windows, macOS).
    const names = ['chat-data.json', 'config.json', ...(['win32', 'darwin'].includes(process.platform) ? ['Chat-Data.json'] : [])];
    for (const name of names) {
      assert.strictEqual(caseToolGuard('Write', { file_path: path.join(env.dataDir, name), content: '{}' }, ctx).success, false, name);
    }
  });

  it('refuses writes to the chat-data backups and the history store files', async () => {
    const { env, ctx } = await setup();
    const names = [
      'chat-data.backup-2026-09-29T10-00-00-000Z.json',
      'history.sqlite', 'history.sqlite-wal', 'history.sqlite-shm',
      'chat-history.sqlite', 'chat-history.sqlite-wal', 'chat-history.sqlite-shm'
    ];
    for (const name of names) {
      const r = caseToolGuard('Write', { file_path: path.join(env.dataDir, name), content: 'x' }, ctx);
      assert.strictEqual(r && r.success, false, name);
    }
    assert.strictEqual(caseToolGuard('Write', { file_path: path.join(env.dataDir, 'history-notes.md'), content: 'x' }, ctx), null);
  });

  it('is off outside cases, and uses the configured runtime for a child\'s guardContext', async () => {
    const { meta } = await setup();
    assert.strictEqual(caseToolGuard('BrowserPage', { action: 'fill', selector: '#a', text: 'x' }, {}), null);
    assert.strictEqual(caseToolGuard('WebSearch', { query: 'above 98000' }, { guardContext: { caseId: meta.id } }).success, false);
    configureCaseGuard({});
    assert.match(caseToolGuard('WebSearch', { query: 'permit fees' }, { guardContext: { caseId: meta.id } }).error, /not available to check/);
  });
});

describe('data-dir write check resists path tricks', () => {
  const WIN = process.platform === 'win32';
  const refusedWrite = (ctx, file_path) => caseToolGuard('Write', { file_path, content: 'x' }, ctx);

  it('follows a junction in the case dir into executors', async () => {
    const { env, ctx } = await setup();
    fs.mkdirSync(path.join(env.dataDir, 'executors'), { recursive: true });
    fs.symlinkSync(path.join(env.dataDir, 'executors'), path.join(ctx.workingDirectory, 'link'), 'junction');
    assert.strictEqual(refusedWrite(ctx, path.join('link', 'adapter.js')).success, false);
  });

  it('drops stream suffixes and trailing dots or spaces', async () => {
    const { env, ctx } = await setup();
    for (const name of ['ops-memory.jsonl::$DATA', 'ops-memory.jsonl:x', 'ops-memory.jsonl.', 'ops-memory.jsonl ', 'OPS-MEMORY.JSONL']) {
      if (name === 'OPS-MEMORY.JSONL' && !(WIN || process.platform === 'darwin')) continue;
      assert.strictEqual(refusedWrite(ctx, path.join(env.dataDir, name)).success, false, name);
    }
  });

  it('strips long-path and device prefixes', { skip: !WIN }, async () => {
    const { env, ctx } = await setup();
    const target = path.join(env.dataDir, 'executors', 'x.js');
    assert.strictEqual(refusedWrite(ctx, `\\\\?\\${target}`).success, false);
    assert.strictEqual(refusedWrite(ctx, `\\\\.\\${target}`).success, false);
  });

  it('resolves an 8.3 short name', { skip: !WIN }, async (t) => {
    const { env, ctx } = await setup();
    const dir = path.join(env.dataDir, 'executors');
    fs.mkdirSync(dir, { recursive: true });
    let short = '';
    try {
      short = execFileSync('cmd', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim();
    } catch {}
    if (!short || path.basename(short).toLowerCase() === 'executors') return t.skip('8.3 names are off on this volume');
    assert.match(path.basename(short), /~/);
    assert.strictEqual(refusedWrite(ctx, path.join(short, 'adapter.js')).success, false);
  });

  it('treats a file named ..x.js inside executors as inside', async () => {
    const { env, ctx } = await setup();
    assert.strictEqual(refusedWrite(ctx, path.join(env.dataDir, 'executors', '..x.js')).success, false);
    assert.strictEqual(refusedWrite(ctx, path.join(env.dataDir, 'executors-notes.md')), null);
    assert.strictEqual(refusedWrite(ctx, path.join(env.dataDir, 'workflows', 'wf-1.json')).success, false);
  });

  it('segmentsWithin treats only a whole .. segment as outside', () => {
    const { segmentsWithin } = require('../src/cases/safe-path');
    const base = fx.tempDir('kl-seg-');
    assert.deepStrictEqual(segmentsWithin(base, path.join(base, '..x.js')), ['..x.js']);
    assert.deepStrictEqual(segmentsWithin(base, path.join(base, 'executors', '..x.js')), ['executors', '..x.js']);
    assert.strictEqual(segmentsWithin(base, path.join(base, '..', 'x.js')), null);
    assert.deepStrictEqual(segmentsWithin(base, base), []);
  });
});

describe('percent-encoded case data in urls', () => {
  it('gates the decoded url as well as the raw one', async () => {
    const { ctx } = await setup();
    for (const q of ['98%2C000', '98+000', '%39%38%30%30%30', '%2539%2538%2530%2530%2530', '%E0%A4%A&x=%39%38%30%30%30']) {
      const url = `https://records.example.org/search?q=${q}`;
      assert.strictEqual(caseToolGuard('WebFetch', { url }, ctx).success, false, q);
      assert.strictEqual(caseToolGuard('BrowserPage', { action: 'navigate', url }, ctx).success, false, q);
      assert.strictEqual(caseToolGuard('BrowserSession', { action: 'open_tab', url }, ctx).success, false, q);
      assert.strictEqual(caseToolGuard('Browser', { action: 'navigate', url }, ctx).success, false, q);
    }
    assert.strictEqual(caseToolGuard('WebFetch', { url: 'https://permits.example.com/county%20fees?a=1+2' }, ctx), null);
  });
});

describe('browser start in a case', () => {
  it('runs only in the kl-cases profile and never a raw user data path', async () => {
    const { ctx } = await setup();
    for (const tool of ['BrowserSession', 'Browser']) {
      assert.strictEqual(caseToolGuard(tool, { action: 'start', profile: 'kl-cases' }, ctx), null, tool);
      for (const p of [{}, { profile: 'personal' }, { profile: 'kl-cases', userDataPath: '/tmp/chrome' }, { userDataPath: '/tmp/chrome' }]) {
        assert.strictEqual(caseToolGuard(tool, { action: 'start', ...p }, ctx).success, false, `${tool} ${JSON.stringify(p)}`);
      }
    }
  });
});
