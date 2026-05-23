const { describe, it } = require('node:test');
const assert = require('node:assert');
const Fixit = require('../src/diagnostics/fixit');

const makeStore = (data = {}) => ({
  get: (key, fallback) => data[key] !== undefined ? data[key] : fallback
});

describe('Fixit', () => {
  const mockContext = {
    providerFactory: {},
    channelRegistry: { getChannels: () => ['telegram'] },
    memoryManager: {},
    hookRegistry: {},
    skillRegistry: { getSkills: () => ['hello-world'] },
    gateway: {},
    cronScheduler: { getJobs: () => [] },
    store: makeStore({
      apiTokens: { openai: 'enc-token' },
      apiStatus: { openai: { ok: true, lastChecked: Date.now() } },
      settings: { activeProvider: 'openai' }
    })
  };

  it('runs all checks and returns results', async () => {
    const fixit = new Fixit(mockContext);
    const results = await fixit.runAll();
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
    results.forEach(r => {
      assert.ok(r.name);
      assert.ok(['PASS', 'WARN', 'FAIL', 'SKIP', 'INFO'].includes(r.status));
      assert.ok(r.message);
    });
  });

  it('handles check failures gracefully', async () => {
    const fixit = new Fixit({});
    const results = await fixit.runAll();
    assert.ok(results.every(r => r.status));
  });

  it('formats results as readable text', () => {
    const fixit = new Fixit({});
    const text = fixit.formatResults([
      { name: 'Test', status: 'PASS', message: 'OK' },
      { name: 'Broken', status: 'FAIL', message: 'Error', fix: 'Do this' }
    ]);
    assert.ok(text.includes('[PASS]'));
    assert.ok(text.includes('[FAIL]'));
    assert.ok(text.includes('Fixit:'));
  });

  it('completes in under 10 seconds', async () => {
    const fixit = new Fixit(mockContext);
    const start = Date.now();
    await fixit.runAll();
    assert.ok(Date.now() - start < 10000);
  });

  it('returns correct number of checks', async () => {
    const fixit = new Fixit(mockContext);
    const results = await fixit.runAll();
    assert.strictEqual(results.length, 10);
  });

  it('skips checks when dependencies are missing', async () => {
    const fixit = new Fixit({});
    const results = await fixit.runAll();
    const skipped = results.filter(r => r.status === 'SKIP');
    assert.ok(skipped.length > 0);
  });

  it('detects provider with stored token', async () => {
    const fixit = new Fixit({
      providerFactory: {},
      store: makeStore({
        apiTokens: { openai: 'enc-token' },
        settings: { activeProvider: 'openai' }
      })
    });
    const results = await fixit.runAll();
    const provider = results.find(r => r.name === 'Provider Connectivity');
    assert.strictEqual(provider.status, 'PASS');
    assert.ok(provider.message.includes('openai'));
  });

  it('detects Ollama as configured without a stored token', async () => {
    const fixit = new Fixit({
      providerFactory: {},
      store: makeStore({
        apiTokens: {},
        settings: { activeProvider: 'ollama' }
      })
    });
    const results = await fixit.runAll();
    const provider = results.find(r => r.name === 'Provider Connectivity');
    assert.strictEqual(provider.status, 'PASS');
    assert.ok(provider.message.includes('ollama'));
  });

  it('warns when no providers are configured', async () => {
    const fixit = new Fixit({
      providerFactory: {},
      store: makeStore({
        apiTokens: {},
        settings: { activeProvider: 'openai' }
      })
    });
    const results = await fixit.runAll();
    const provider = results.find(r => r.name === 'Provider Connectivity');
    assert.strictEqual(provider.status, 'WARN');
    assert.ok(provider.fix);
  });

  it('warns when active provider last connection failed', async () => {
    const fixit = new Fixit({
      providerFactory: {},
      store: makeStore({
        apiTokens: { openai: 'enc-token' },
        apiStatus: { openai: { ok: false, message: '401 Unauthorized' } },
        settings: { activeProvider: 'openai' }
      })
    });
    const results = await fixit.runAll();
    const provider = results.find(r => r.name === 'Provider Connectivity');
    assert.strictEqual(provider.status, 'WARN');
    assert.ok(provider.message.includes('failed'));
  });
});
