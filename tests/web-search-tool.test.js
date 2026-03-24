const { describe, it } = require('node:test');
const assert = require('node:assert');

const SearchProvider = require('../src/web-search/search-provider');
const DuckDuckGoSearch = require('../src/web-search/providers/duckduckgo');
const BraveSearch = require('../src/web-search/providers/brave-search');
const TavilySearch = require('../src/web-search/providers/tavily');
const WebSearchTool = require('../src/tools/builtin/web-search-tool');

describe('SearchProvider base class', () => {
  it('throws on unimplemented methods', async () => {
    const provider = new SearchProvider('key');
    assert.throws(() => provider.getName());
    await assert.rejects(() => provider.search('test', 5));
  });

  it('isConfigured returns false by default', () => {
    const provider = new SearchProvider('key');
    assert.strictEqual(provider.isConfigured(), false);
  });
});

describe('DuckDuckGo provider', () => {
  it('is configured without API key', () => {
    const ddg = new DuckDuckGoSearch();
    assert.strictEqual(ddg.isConfigured(), true);
  });

  it('getName returns duckduckgo', () => {
    const ddg = new DuckDuckGoSearch();
    assert.strictEqual(ddg.getName(), 'duckduckgo');
  });

  // Note: we don't do an actual fetch in unit tests unless we mock it,
  // but let's test that the structure returned looks like a provider object.
  it('returns correctly shaped class', () => {
    const ddg = new DuckDuckGoSearch();
    assert.strictEqual(typeof ddg.search, 'function');
  });
});

describe('BraveSearch provider', () => {
  it('requires API key', () => {
    const brave = new BraveSearch('');
    assert.strictEqual(brave.isConfigured(), false);
    const configured = new BraveSearch('test');
    assert.strictEqual(configured.isConfigured(), true);
  });

  it('getName returns brave', () => {
    const brave = new BraveSearch();
    assert.strictEqual(brave.getName(), 'brave');
  });
});

describe('TavilySearch provider', () => {
  it('requires API key', () => {
    const tavily = new TavilySearch('');
    assert.strictEqual(tavily.isConfigured(), false);
    const configured = new TavilySearch('test');
    assert.strictEqual(configured.isConfigured(), true);
  });

  it('getName returns tavily', () => {
    const tavily = new TavilySearch();
    assert.strictEqual(tavily.getName(), 'tavily');
  });
});

describe('WebSearch Tool', () => {
  it('auto-detects provider based on configured keys', () => {
    const getDefaultProvider = require('../src/tools/builtin/web-search-tool').getDefaultProvider;

    assert.strictEqual(getDefaultProvider({}), 'duckduckgo');
    assert.strictEqual(getDefaultProvider({ webSearch: { brave: { apiKey: 'x' } } }), 'brave');
    assert.strictEqual(getDefaultProvider({ webSearch: { tavily: { apiKey: 'x' } } }), 'tavily');
    assert.strictEqual(getDefaultProvider({ webSearch: { brave: { apiKey: 'x' }, tavily: { apiKey: 'y' } } }), 'brave');
  });

  it('has required parameters', () => {
    assert.strictEqual(WebSearchTool.name, 'WebSearch');
    assert.ok(WebSearchTool.parameters.properties.query);
    assert.ok(WebSearchTool.parameters.required.includes('query'));
  });

  it('does not require approval', () => {
    assert.strictEqual(WebSearchTool.requiresApproval, false);
  });
});
