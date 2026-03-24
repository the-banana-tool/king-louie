const SearchProvider = require('../search-provider');

class TavilySearch extends SearchProvider {
  constructor(apiKey) {
    super(apiKey);
  }

  getName() {
    return 'tavily';
  }

  isConfigured() {
    return Boolean(this.apiKey && this.apiKey.trim().length > 0);
  }

  async search(query, maxResults = 10) {
    if (!this.isConfigured()) {
      throw new Error('Tavily Search is not configured. Missing API key.');
    }

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        api_key: this.apiKey,
        query: query,
        max_results: maxResults,
        search_depth: 'basic',
        include_answer: false,
        include_images: false,
        include_raw_content: false
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Tavily Search API error (${res.status}): ${errorText}`);
    }

    const data = await res.json();

    if (!data.results || !Array.isArray(data.results)) {
      return [];
    }

    return data.results.map(result => ({
      title: result.title,
      url: result.url,
      snippet: result.content || ''
    }));
  }
}

module.exports = TavilySearch;
