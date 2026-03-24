const SearchProvider = require('../search-provider');
const { parseHTML } = require('linkedom');

class DuckDuckGoSearch extends SearchProvider {
  constructor(apiKey) {
    super(apiKey);
  }

  getName() {
    return 'duckduckgo';
  }

  isConfigured() {
    return true;
  }

  async search(query, maxResults = 10) {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    if (!res.ok) {
      throw new Error(`DuckDuckGo Search returned ${res.status}`);
    }

    const html = await res.text();
    const { document } = parseHTML(html);

    const results = [];
    const elements = document.querySelectorAll('.result');

    for (const el of elements) {
      if (results.length >= maxResults) break;

      const titleEl = el.querySelector('.result__title a');
      const snippetEl = el.querySelector('.result__snippet');

      if (titleEl && snippetEl) {
        const title = titleEl.textContent?.trim();
        const url = titleEl.getAttribute('href');
        // If url is a relative redirect, we should parse it, but for simplicity let's assume it's directly useful or we can extract it
        let finalUrl = url;
        if (url && url.startsWith('//duckduckgo.com/l/?')) {
            try {
              const urlParams = new URL('https:' + url).searchParams;
              const uddg = urlParams.get('uddg');
              if (uddg) finalUrl = decodeURIComponent(uddg);
            } catch(e) {}
        }

        const snippet = snippetEl.textContent?.trim();

        if (title && finalUrl && snippet) {
          results.push({
            title,
            url: finalUrl,
            snippet
          });
        }
      }
    }

    return results;
  }
}

module.exports = DuckDuckGoSearch;
