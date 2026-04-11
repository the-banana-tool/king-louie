const { Tool } = require('../tool-schema');
const { validateUrl, extractReadableContent, stripNonContent, htmlToMarkdown, htmlToText } = require('./web-fetch-utils');

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
  concurrencySafe: true,
  execute: async (params, context = {}) => {
    const { url: urlString, extractMode = 'markdown', maxChars = 50000 } = params;
    const { signal } = context;

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
    // Forward turn-level cancellation: when the agent loop's signal aborts,
    // tear down this fetch too instead of letting it complete in the dark.
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    try {
      const res = await fetch(urlString, {
        signal: controller.signal,
        headers: { 'User-Agent': 'King-Louie/1.0' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const contentType = res.headers.get('content-type') || '';
      const contentLength = res.headers.get('content-length');

      // Fetch up to 10MB of raw HTML — script/style stripping and Readability
      // extraction happen downstream, so the useful content is much smaller.
      const MAX_BYTES = 10 * 1024 * 1024; // 10MB
      let truncated = false;

      let raw = '';
      if (res.body) {
        // Stream response, capping at 2MB
        const decoder = new TextDecoder('utf-8');
        const reader = res.body.getReader();
        let bytesRead = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            if (value) {
              bytesRead += value.length;
              if (bytesRead > MAX_BYTES) {
                // Decode the partial chunk up to the limit
                const excess = bytesRead - MAX_BYTES;
                const usable = value.length - excess;
                if (usable > 0) {
                  raw += decoder.decode(value.slice(0, usable), { stream: true });
                }
                truncated = true;
                break;
              }
              raw += decoder.decode(value, { stream: true });
            }
          }
        } finally {
          try { reader.cancel(); } catch { /* ok */ }
        }
        raw += decoder.decode();
      }

      let output;
      if (contentType.includes('text/html')) {
        const article = extractReadableContent(raw, urlString);
        // If Readability extracted an article, use it; otherwise strip JS/CSS and convert
        const content = article ? article.content : stripNonContent(raw);
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
        truncated = true;
      }

      return { ok: true, content: output, truncated };
    } finally {
      clearTimeout(timeout);
    }
  }
});

// For testing purposes
webFetchTool._cache = cache;

module.exports = webFetchTool;
