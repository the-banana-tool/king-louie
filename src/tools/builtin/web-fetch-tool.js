const { Tool } = require('../tool-schema');
const { validateUrl, extractReadableContent, htmlToMarkdown, htmlToText } = require('./web-fetch-utils');

// 15 minute cache TTL
const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();

const webFetchTool = new Tool({
  name: 'WebFetch',
  description: 'Fetch a URL and extract its content as readable text or markdown',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'HTTP or HTTPS URL to fetch' },
      extractMode: { type: 'string', enum: ['markdown', 'text'], default: 'markdown' },
      maxChars: { type: 'number', minimum: 100, default: 50000 }
    },
    required: ['url']
  },
  requiresApproval: false,
  execute: async (params) => {
    const { url: urlString, extractMode = 'markdown', maxChars = 50000 } = params;

    // Check cache
    const cacheKey = `${urlString}::${extractMode}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      // Re-apply truncation limits based on current params
      let output = cached.content;
      if (output.length > maxChars) {
        output = output.slice(0, maxChars) + '\n\n[Content truncated]';
      }
      return { ok: true, content: output };
    }

    // Validate URL and check SSRF
    await validateUrl(urlString);

    // Fetch with timeout and size limit
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(urlString, {
        signal: controller.signal,
        headers: { 'User-Agent': 'King-Louie/1.0' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const contentType = res.headers.get('content-type') || '';
      const contentLength = res.headers.get('content-length');

      // Check header first
      if (contentLength && parseInt(contentLength, 10) > 2097152) {
        throw new Error('Response exceeds 2MB limit');
      }

      let raw = '';
      if (res.body) {
        // Stream response to enforce 2MB limit without loading entire payload in memory
        const decoder = new TextDecoder('utf-8');
        const reader = res.body.getReader();
        let bytesRead = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          if (value) {
            bytesRead += value.length;
            if (bytesRead > 2097152) {
              throw new Error('Response exceeds 2MB limit');
            }
            raw += decoder.decode(value, { stream: true });
          }
        }
        raw += decoder.decode();
      }

      let output;
      if (contentType.includes('text/html')) {
        const article = extractReadableContent(raw, urlString);
        const content = article ? article.content : raw;
        output = extractMode === 'markdown' ? htmlToMarkdown(content) : htmlToText(content);
        if (article?.title) output = `# ${article.title}\n\n${output}`;
      } else {
        output = raw;
      }

      // Store in cache (untruncated)
      cache.set(cacheKey, { timestamp: Date.now(), content: output });

      // Truncate to maxChars
      if (output.length > maxChars) {
        output = output.slice(0, maxChars) + '\n\n[Content truncated]';
      }

      return { ok: true, content: output };
    } finally {
      clearTimeout(timeout);
    }
  }
});

// For testing purposes
webFetchTool._cache = cache;

module.exports = webFetchTool;
