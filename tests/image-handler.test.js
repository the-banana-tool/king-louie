const { describe, it, mock } = require('node:test');
const assert = require('node:assert');

const ImageHandler = require('../src/media/image-handler');

describe('ImageHandler', () => {
  it('validates supported formats', () => {
    assert.doesNotThrow(() => ImageHandler.validateImage(Buffer.alloc(100), 'image/png'));
    assert.doesNotThrow(() => ImageHandler.validateImage(Buffer.alloc(100), 'image/jpeg'));
    assert.throws(() => ImageHandler.validateImage(Buffer.alloc(100), 'image/bmp'), /Unsupported image format/);
    assert.throws(() => ImageHandler.validateImage(Buffer.alloc(100), 'application/pdf'), /Unsupported image format/);
  });

  it('rejects oversized images', () => {
    const bigBuffer = Buffer.alloc(6 * 1024 * 1024);
    assert.throws(() => ImageHandler.validateImage(bigBuffer, 'image/png'), /Image too large/);
  });

  it('formats for OpenAI', () => {
    const formatted = ImageHandler.formatForProvider('openai', { base64: 'abc123', mimeType: 'image/png' });
    assert.strictEqual(formatted.type, 'image_url');
    assert.ok(formatted.image_url.url.startsWith('data:image/png;base64,'));
  });

  it('formats for Anthropic', () => {
    const formatted = ImageHandler.formatForProvider('anthropic', { base64: 'abc123', mimeType: 'image/jpeg' });
    assert.strictEqual(formatted.type, 'image');
    assert.strictEqual(formatted.source.type, 'base64');
    assert.strictEqual(formatted.source.media_type, 'image/jpeg');
  });

  it('formats for Gemini', () => {
    const formatted = ImageHandler.formatForProvider('gemini', { base64: 'abc123', mimeType: 'image/png' });
    assert.ok(formatted.inlineData);
    assert.strictEqual(formatted.inlineData.mimeType, 'image/png');
    assert.strictEqual(formatted.inlineData.data, 'abc123');
  });

  it('throws for unsupported provider', () => {
    assert.throws(() => ImageHandler.formatForProvider('groq', { base64: 'x', mimeType: 'image/png' }), /does not support images/);
  });

  it('normalizes valid message images with size metadata', () => {
    const base64 = Buffer.from('tiny-image').toString('base64');
    const normalized = ImageHandler.normalizeMessageImages([
      { base64, mimeType: 'image/png', name: 'tiny.png' }
    ]);

    assert.strictEqual(normalized.length, 1);
    assert.strictEqual(normalized[0].name, 'tiny.png');
    assert.strictEqual(normalized[0].mimeType, 'image/png');
    assert.ok(normalized[0].sizeBytes > 0);
  });

  it('rejects too many images per message', () => {
    const base64 = Buffer.from('tiny-image').toString('base64');
    const images = Array.from({ length: 6 }, () => ({ base64, mimeType: 'image/png' }));
    assert.throws(() => ImageHandler.normalizeMessageImages(images), /Too many images/);
  });

  it('processes base64 input', async () => {
    const base64 = Buffer.from('tiny-image').toString('base64');
    const result = await ImageHandler.processImage({
      type: 'base64',
      data: base64,
      mimeType: 'image/png',
      name: 'tiny.png'
    });

    assert.strictEqual(result.mimeType, 'image/png');
    assert.strictEqual(result.name, 'tiny.png');
    assert.ok(result.sizeBytes > 0);
  });

  it('processes url input with fetched image bytes', async () => {
    const originalFetch = global.fetch;
    const base64 = Buffer.from('tiny-image').toString('base64');
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));

    global.fetch = mock.fn(async () => ({
      ok: true,
      headers: {
        get: () => 'image/png'
      },
      arrayBuffer: async () => bytes.buffer
    }));

    try {
      const result = await ImageHandler.processImage({ type: 'url', url: 'https://example.com/tiny.png' });
      assert.strictEqual(result.mimeType, 'image/png');
      assert.ok(result.sizeBytes > 0);
      assert.ok(typeof result.base64 === 'string' && result.base64.length > 0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
