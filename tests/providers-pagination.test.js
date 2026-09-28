// tests/providers-pagination.test.js
// Anthropic's GET /v1/models pages at 20 by default (limit up to 1000,
// has_more/after_id); Gemini's models.list pages at 50 by default (pageSize
// up to 1000, nextPageToken). Before this, listModels() read only the first
// page, so a model past page 1 was refused at send time as "not in this
// account's model list" even though the account has it (spec 2026-09-27
// §5.1, final review I1).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const GeminiProvider = require('../src/providers/gemini-provider');

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Anthropic listModels follows pagination', () => {
  it('reads a second page via has_more/after_id and returns every model', async () => {
    const seen = [];
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      seen.push({ limit: u.searchParams.get('limit'), afterId: u.searchParams.get('after_id') });
      if (!u.searchParams.get('after_id')) {
        return json({ data: [{ id: 'claude-a' }, { id: 'claude-b' }], has_more: true, first_id: 'claude-a', last_id: 'claude-b' });
      }
      return json({ data: [{ id: 'claude-c' }], has_more: false, first_id: 'claude-c', last_id: 'claude-c' });
    };
    const provider = new AnthropicProvider('sk-ant-test-123456');
    const ids = await provider.listModels();
    assert.deepStrictEqual(ids, ['claude-a', 'claude-b', 'claude-c']);
    assert.strictEqual(seen.length, 2, 'a second request follows has_more');
    assert.strictEqual(seen[0].limit, '1000');
    assert.strictEqual(seen[0].afterId, null);
    assert.strictEqual(seen[1].afterId, 'claude-b', 'the second request carries the prior page\'s last_id');
  });

  it('stops after one page when has_more is false', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return json({ data: [{ id: 'claude-a' }], has_more: false }); };
    const provider = new AnthropicProvider('sk-ant-test-123456');
    assert.deepStrictEqual(await provider.listModels(), ['claude-a']);
    assert.strictEqual(calls, 1);
  });
});

describe('Gemini listModels follows pagination', () => {
  it('reads a second page via nextPageToken and returns every model', async () => {
    const seen = [];
    globalThis.fetch = async (url) => {
      const u = new URL(url);
      seen.push({ pageSize: u.searchParams.get('pageSize'), pageToken: u.searchParams.get('pageToken') });
      if (!u.searchParams.get('pageToken')) {
        return json({
          models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }],
          nextPageToken: 'page-2'
        });
      }
      return json({ models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] });
    };
    const provider = new GeminiProvider('AIza-test-123456');
    const ids = await provider.listModels();
    assert.deepStrictEqual(ids, ['gemini-a', 'gemini-b']);
    assert.strictEqual(seen.length, 2, 'a second request follows nextPageToken');
    assert.strictEqual(seen[0].pageSize, '1000');
    assert.strictEqual(seen[0].pageToken, null);
    assert.strictEqual(seen[1].pageToken, 'page-2');
  });

  it('stops after one page when there is no nextPageToken', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return json({ models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }] });
    };
    const provider = new GeminiProvider('AIza-test-123456');
    assert.deepStrictEqual(await provider.listModels(), ['gemini-a']);
    assert.strictEqual(calls, 1);
  });
});
