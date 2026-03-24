const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { validateUrl, isPrivateIp, htmlToMarkdown, htmlToText } = require('../src/tools/builtin/web-fetch-utils');
const webFetchTool = require('../src/tools/builtin/web-fetch-tool');

describe('WebFetch SSRF Protection', () => {
  it('blocks file:// protocol', async () => {
    await assert.rejects(
      () => validateUrl('file:///etc/passwd'),
      /Blocked protocol/
    );
  });

  it('blocks ftp:// protocol', async () => {
    await assert.rejects(
      () => validateUrl('ftp://evil.com/file'),
      /Blocked protocol/
    );
  });

  it('identifies private IPs', () => {
    assert.ok(isPrivateIp('127.0.0.1'));
    assert.ok(isPrivateIp('10.0.0.1'));
    assert.ok(isPrivateIp('192.168.1.1'));
    assert.ok(isPrivateIp('172.16.0.1'));
    assert.ok(!isPrivateIp('8.8.8.8'));
    assert.ok(!isPrivateIp('1.1.1.1'));
  });

  it('allows http:// URLs', async () => {
    // Should not throw for valid public URLs (just validates, doesn't fetch)
    await assert.doesNotReject(
      () => validateUrl('https://example.com', true)
    );
  });
});

describe('WebFetch Content Extraction', () => {
  it('converts HTML to markdown', () => {
    const html = '<h1>Title</h1><p>Hello <strong>world</strong></p>';
    const md = htmlToMarkdown(html);
    assert.ok(md.includes('# Title'));
    assert.ok(md.includes('**world**'));
  });

  it('converts HTML to plain text', () => {
    const html = '<h1>Title</h1><p>Hello <strong>world</strong></p>';
    const text = htmlToText(html);
    assert.ok(!text.includes('<'));
    assert.ok(text.includes('Title'));
    assert.ok(text.includes('world'));
  });

  it('truncates content to maxChars', async () => {
    // Create a tool execution with maxChars: 100 and a long response
    // First clear cache
    webFetchTool._cache.clear();

    const originalFetch = global.fetch;
    global.fetch = async () => {
      const text = '<h1>Long Content</h1><p>' + 'A'.repeat(500) + '</p>';
      const encoder = new TextEncoder();
      const chunks = [encoder.encode(text)];
      let i = 0;
      return {
        ok: true,
        headers: { get: () => 'text/html' },
        body: {
          getReader: () => ({
            read: async () => {
              if (i < chunks.length) {
                return { done: false, value: chunks[i++] };
              }
              return { done: true, value: undefined };
            }
          })
        }
      };
    };

    try {
      const result = await webFetchTool.execute({
        url: 'https://example.com',
        maxChars: 50
      });

      assert.ok(result.ok);
      assert.ok(result.content.length <= 50 + '\n\n[Content truncated]'.length);
      assert.ok(result.content.includes('[Content truncated]'));
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('WebFetch Cache', () => {
  beforeEach(() => {
    webFetchTool._cache.clear();
  });

  it('returns cached result for same URL within TTL', async () => {
    const originalFetch = global.fetch;
    let fetchCount = 0;

    global.fetch = async () => {
      fetchCount++;
      const text = '<h1>Test Cache</h1><p>Content</p>';
      const encoder = new TextEncoder();
      const chunks = [encoder.encode(text)];
      let i = 0;

      return {
        ok: true,
        headers: { get: () => 'text/html' },
        body: {
          getReader: () => ({
            read: async () => {
              if (i < chunks.length) {
                return { done: false, value: chunks[i++] };
              }
              return { done: true, value: undefined };
            }
          })
        }
      };
    };

    try {
      await webFetchTool.execute({ url: 'https://example.com' });
      assert.strictEqual(fetchCount, 1);

      await webFetchTool.execute({ url: 'https://example.com' });
      assert.strictEqual(fetchCount, 1); // Should be 1 because it hit the cache
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('cache expires after TTL', async () => {
    // Manually set an expired cache entry
    webFetchTool._cache.set('https://example.com::markdown', {
      timestamp: Date.now() - (16 * 60 * 1000), // 16 minutes ago
      content: 'Expired content'
    });

    const originalFetch = global.fetch;
    let fetchCount = 0;

    global.fetch = async () => {
      fetchCount++;
      const text = '<h1>Fresh Content</h1><p>Content</p>';
      const encoder = new TextEncoder();
      const chunks = [encoder.encode(text)];
      let i = 0;

      return {
        ok: true,
        headers: { get: () => 'text/html' },
        body: {
          getReader: () => ({
            read: async () => {
              if (i < chunks.length) {
                return { done: false, value: chunks[i++] };
              }
              return { done: true, value: undefined };
            }
          })
        }
      };
    };

    try {
      const result = await webFetchTool.execute({ url: 'https://example.com' });
      assert.strictEqual(fetchCount, 1); // Should fetch because cache expired
      assert.ok(result.content.includes('Fresh Content'));
    } finally {
      global.fetch = originalFetch;
    }
  });
});
