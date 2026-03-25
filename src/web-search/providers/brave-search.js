const SearchProvider = require('../search-provider');

class BraveSearch extends SearchProvider {
  constructor(apiKey) {
    super(apiKey);
  }

  getName() {
    return 'brave';
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async search(query, maxResults = 10) {
    if (!this.isConfigured()) {
      throw new Error('Brave Search is not configured. Missing API key.');
    }

    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': this.apiKey
      }
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Brave Search API error (${res.status}): ${errorText}`);
    }

    const data = await res.json();

    if (!data.web || !data.web.results) {
      return [];
    }

    return data.web.results.map(result => ({
      title: result.title,
      url: result.url,
      snippet: result.description || ''
    }));
  }
}

module.exports = BraveSearch;
