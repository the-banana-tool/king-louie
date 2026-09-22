const { Tool } = require('../tool-schema');

const DuckDuckGoSearch = require('../../web-search/providers/duckduckgo');
const BraveSearch = require('../../web-search/providers/brave-search');
const TavilySearch = require('../../web-search/providers/tavily');

const { decryptSettingKey } = require('../utils');

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
  concurrencySafe: true,
  execute: async (params, context) => {
    const { query, maxResults = 10 } = params;

    const settings = typeof context?.getSettings === 'function' ? (context.getSettings() || {}) : {};

    const providerName = getDefaultProvider(settings);
    let provider;

    // Fail closed before the request is built: an undecryptable key must not
    // be shipped to Brave or Tavily as if it were the credential.
    try {
      if (providerName === 'brave') {
        provider = new BraveSearch(decryptSettingKey(settings.webSearch.brave.apiKey, context, 'Brave Search'));
      } else if (providerName === 'tavily') {
        provider = new TavilySearch(decryptSettingKey(settings.webSearch.tavily.apiKey, context, 'Tavily'));
      } else {
        provider = new DuckDuckGoSearch();
      }
    } catch (error) {
      return { ok: false, error: error.message };
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
