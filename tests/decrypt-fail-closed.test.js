// A4 — when a stored API key cannot be decrypted, fail closed. Never hand the
// ciphertext to a remote service as if it were the credential.
const { describe, it } = require('node:test');
const assert = require('node:assert');

const WebSearchTool = require('../src/tools/builtin/web-search-tool');
const ImageGenerateTool = require('../src/tools/builtin/image-generate-tool');
const { decryptSettingKey } = require('../src/tools/utils');

const CIPHERTEXT = 'v10:3q2+7w==:Zm9vYmFyYmF6';

// The realistic triggers: a Linux desktop with no Secret Service, a rotated or
// restored keychain/DPAPI entry, or a cross-host format mismatch between the
// Electron store's legacy safeStorage blobs and the service's AES-GCM ones.
const throwingContext = {
  decryptToken: () => { throw new Error('Unrecognized ciphertext format.'); }
};

describe('decryptSettingKey (A4)', () => {
  it('rethrows as a clear error rather than returning the ciphertext', () => {
    assert.throws(
      () => decryptSettingKey(CIPHERTEXT, throwingContext, 'Brave'),
      (err) => {
        assert.match(err.message, /decrypt/i);
        assert.match(err.message, /Brave/);
        assert.ok(!err.message.includes(CIPHERTEXT), 'the ciphertext must not be echoed');
        return true;
      }
    );
  });

  it('returns null for an unset key', () => {
    assert.strictEqual(decryptSettingKey(undefined, throwingContext, 'Brave'), null);
    assert.strictEqual(decryptSettingKey('', throwingContext, 'Brave'), null);
  });

  it('passes the plaintext through when decryption works', () => {
    const ctx = { decryptToken: (v) => `plain:${v}` };
    assert.strictEqual(decryptSettingKey(CIPHERTEXT, ctx, 'Brave'), `plain:${CIPHERTEXT}`);
  });

  it('returns the value as-is when the host offers no decryptToken', () => {
    assert.strictEqual(decryptSettingKey('sk-plain', {}, 'Brave'), 'sk-plain');
  });
});

describe('WebSearch with an undecryptable key (A4)', () => {
  it('refuses to search instead of sending the ciphertext to Brave', async (t) => {
    // If the tool ever reaches the network, this catches it: the ciphertext
    // would be going out as X-Subscription-Token.
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('the tool must not make a request with an undecryptable key');
    });

    const result = await WebSearchTool.execute({ query: 'anything' }, {
      ...throwingContext,
      getSettings: () => ({ webSearch: { brave: { apiKey: CIPHERTEXT } } })
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /decrypt/i);
    assert.strictEqual(fetchMock.mock.callCount(), 0, 'no request may be made');
  });

  it('refuses to search instead of sending the ciphertext to Tavily', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('the tool must not make a request with an undecryptable key');
    });

    const result = await WebSearchTool.execute({ query: 'anything' }, {
      ...throwingContext,
      getSettings: () => ({ webSearch: { tavily: { apiKey: CIPHERTEXT } } })
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /decrypt/i);
    assert.strictEqual(fetchMock.mock.callCount(), 0, 'no request may be made');
  });

  it('still falls back to DuckDuckGo when no key is configured at all', async () => {
    // getDefaultProvider picks duckduckgo, which takes no key — the failure
    // must be scoped to a key that exists and will not decrypt.
    const { getDefaultProvider } = WebSearchTool;
    assert.strictEqual(getDefaultProvider({ webSearch: {} }), 'duckduckgo');
  });
});

describe('ImageGenerate with an undecryptable key (A4)', () => {
  it('refuses to generate instead of sending the ciphertext to Fal', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('the tool must not make a request with an undecryptable key');
    });

    const result = await ImageGenerateTool.execute({ prompt: 'a cat', provider: 'fal' }, {
      ...throwingContext,
      getSettings: () => ({ imageGeneration: { fal: { apiKey: CIPHERTEXT } } })
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /decrypt/i);
    assert.strictEqual(fetchMock.mock.callCount(), 0, 'no request may be made');
  });

  it('refuses to generate instead of sending the ciphertext to OpenAI', async (t) => {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('the tool must not make a request with an undecryptable key');
    });

    const result = await ImageGenerateTool.execute({ prompt: 'a cat', provider: 'openai' }, {
      ...throwingContext,
      getProviderToken: () => null,
      getSettings: () => ({ imageGeneration: { openai: { apiKey: CIPHERTEXT } } })
    });

    assert.strictEqual(result.ok, false);
    assert.match(result.error, /decrypt/i);
    assert.strictEqual(fetchMock.mock.callCount(), 0, 'no request may be made');
  });
});

