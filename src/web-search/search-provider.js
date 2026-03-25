class SearchProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  getName() {
    throw new Error('Not implemented');
  }

  isConfigured() {
    return false;
  }

  async search(query, maxResults) {
    throw new Error('Not implemented');
  }
}

module.exports = SearchProvider;
