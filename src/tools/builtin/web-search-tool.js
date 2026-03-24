const { Tool } = require('../tool-schema');
const { safeStorage } = require('electron');

const DuckDuckGoSearch = require('../../web-search/providers/duckduckgo');
const BraveSearch = require('../../web-search/providers/brave-search');
const TavilySearch = require('../../web-search/providers/tavily');

function decryptKey(encrypted) {
  if (!encrypted) return null;
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const buffer = Buffer.from(encrypted, 'base64');
      return safeStorage.decryptString(buffer);
    } catch (e) {
      return encrypted; // Fallback or throw
    }
  }
  return encrypted; // In tests where safeStorage isn't available
}

function getDefaultProvider(settings) {
  if (settings?.webSearch?.brave?.apiKey) return 'brave';
  if (settings?.webSearch?.tavily?.apiKey) return 'tavily';
  return 'duckduckgo';
}

const WebSearchTool = new Tool({
  name: 'WebSearch',
  description: 'Search the web for current information.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      maxResults: { type: 'number', default: 10, description: 'Maximum number of results to return' }
    },
    required: ['query']
  },
  requiresApproval: false,
  execute: async (params, context) => {
    const { query, maxResults = 10 } = params;

    // Read from electron-store
    let settings = {};
    try {
      const { default: Store } = await import('electron-store');
      const store = new Store({ name: 'chat-data' });
      settings = store.get('settings') || {};
    } catch (e) {
      // In case electron-store is not available (e.g. in some tests), just pass empty settings
    }

    const providerName = getDefaultProvider(settings);
    let provider;

    if (providerName === 'brave') {
      provider = new BraveSearch(decryptKey(settings.webSearch.brave.apiKey));
    } else if (providerName === 'tavily') {
      provider = new TavilySearch(decryptKey(settings.webSearch.tavily.apiKey));
    } else {
      provider = new DuckDuckGoSearch();
    }

    try {
      const results = await provider.search(query, maxResults);
      return { ok: true, results, provider: provider.getName() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
});

module.exports = WebSearchTool;
module.exports.getDefaultProvider = getDefaultProvider; // Exported for testing
