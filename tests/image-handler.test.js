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

  // --- Document handling ---

  it('validates supported document formats', () => {
    const base64 = Buffer.from('hello world').toString('base64');
    const result = ImageHandler.normalizeMessageDocuments([
      { base64, mimeType: 'text/plain', name: 'readme.txt' }
    ]);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].mimeType, 'text/plain');
    assert.strictEqual(result[0].name, 'readme.txt');
    assert.ok(result[0].sizeBytes > 0);
  });

  it('normalizes all supported document MIME types', () => {
    const base64 = Buffer.from('data').toString('base64');
    for (const mime of ImageHandler.SUPPORTED_DOCUMENT_FORMATS) {
      const result = ImageHandler.normalizeMessageDocuments([{ base64, mimeType: mime }]);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].mimeType, mime);
    }
  });

  it('rejects unsupported document formats', () => {
    const base64 = Buffer.from('data').toString('base64');
    assert.throws(
      () => ImageHandler.normalizeMessageDocuments([{ base64, mimeType: 'application/zip' }]),
      /Unsupported document format/
    );
  });

  it('rejects documents without base64 data', () => {
    assert.throws(
      () => ImageHandler.normalizeMessageDocuments([{ base64: '', mimeType: 'text/plain' }]),
      /Document base64 data is required/
    );
  });

  it('rejects oversized documents', () => {
    const bigBase64 = Buffer.alloc(11 * 1024 * 1024).toString('base64');
    assert.throws(
      () => ImageHandler.normalizeMessageDocuments([{ base64: bigBase64, mimeType: 'text/plain' }]),
      /Document too large/
    );
  });

  it('rejects too many documents per message', () => {
    const base64 = Buffer.from('data').toString('base64');
    const docs = Array.from({ length: 6 }, () => ({ base64, mimeType: 'text/plain' }));
    assert.throws(
      () => ImageHandler.normalizeMessageDocuments(docs),
      /Too many documents/
    );
  });

  it('returns empty array for empty/null document input', () => {
    assert.deepStrictEqual(ImageHandler.normalizeMessageDocuments([]), []);
    assert.deepStrictEqual(ImageHandler.normalizeMessageDocuments(null), []);
    assert.deepStrictEqual(ImageHandler.normalizeMessageDocuments(undefined), []);
  });

  it('preserves textContent through normalization', () => {
    const base64 = Buffer.from('hello').toString('base64');
    const result = ImageHandler.normalizeMessageDocuments([
      { base64, mimeType: 'text/plain', name: 'hi.txt', textContent: 'hello' }
    ]);
    assert.strictEqual(result[0].textContent, 'hello');
  });

  // --- formatDocumentForProvider ---

  it('formats text/plain documents as text blocks for all providers', () => {
    const base64 = Buffer.from('Hello world').toString('base64');
    const doc = { base64, mimeType: 'text/plain', name: 'readme.txt', textContent: 'Hello world' };

    for (const provider of ['anthropic', 'openai', 'gemini']) {
      const result = ImageHandler.formatDocumentForProvider(provider, doc);
      assert.strictEqual(result.type, 'text');
      assert.ok(result.text.includes('Hello world'));
      assert.ok(result.text.includes('readme.txt'));
    }
  });

  it('formats text/markdown documents as text blocks', () => {
    const content = '# Title\n\nSome content';
    const base64 = Buffer.from(content).toString('base64');
    const doc = { base64, mimeType: 'text/markdown', name: 'notes.md', textContent: content };

    const result = ImageHandler.formatDocumentForProvider('anthropic', doc);
    assert.strictEqual(result.type, 'text');
    assert.ok(result.text.includes('# Title'));
    assert.ok(result.text.includes('notes.md'));
  });

  it('formats text/csv documents as text blocks', () => {
    const content = 'name,age\nAlice,30\nBob,25';
    const base64 = Buffer.from(content).toString('base64');
    const doc = { base64, mimeType: 'text/csv', name: 'data.csv', textContent: content };

    const result = ImageHandler.formatDocumentForProvider('openai', doc);
    assert.strictEqual(result.type, 'text');
    assert.ok(result.text.includes('Alice,30'));
  });

  it('decodes base64 for text documents when textContent is missing', () => {
    const content = 'decoded from base64';
    const base64 = Buffer.from(content).toString('base64');
    const doc = { base64, mimeType: 'text/plain', name: 'file.txt' };

    const result = ImageHandler.formatDocumentForProvider('anthropic', doc);
    assert.strictEqual(result.type, 'text');
    assert.ok(result.text.includes('decoded from base64'));
  });

  it('formats PDF as native document type for Anthropic', () => {
    const base64 = Buffer.from('fake-pdf').toString('base64');
    const doc = { base64, mimeType: 'application/pdf', name: 'report.pdf' };

    const result = ImageHandler.formatDocumentForProvider('anthropic', doc);
    assert.strictEqual(result.type, 'document');
    assert.strictEqual(result.source.type, 'base64');
    assert.strictEqual(result.source.media_type, 'application/pdf');
    assert.strictEqual(result.source.data, base64);
  });

  it('formats PDF as inlineData for Gemini', () => {
    const base64 = Buffer.from('fake-pdf').toString('base64');
    const doc = { base64, mimeType: 'application/pdf', name: 'report.pdf' };

    const result = ImageHandler.formatDocumentForProvider('gemini', doc);
    assert.ok(result.inlineData);
    assert.strictEqual(result.inlineData.mimeType, 'application/pdf');
    assert.strictEqual(result.inlineData.data, base64);
  });

  it('formats PDF as text fallback for OpenAI', () => {
    const base64 = Buffer.from('fake-pdf').toString('base64');
    const doc = { base64, mimeType: 'application/pdf', name: 'report.pdf' };

    const result = ImageHandler.formatDocumentForProvider('openai', doc);
    assert.strictEqual(result.type, 'text');
    assert.ok(result.text.includes('report.pdf'));
    assert.ok(result.text.includes('not extractable'));
  });

  it('formats Excel documents as CSV text', () => {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Name', 'Score'], ['Alice', 95], ['Bob', 87]]);
    XLSX.utils.book_append_sheet(wb, ws, 'Results');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const base64 = buffer.toString('base64');

    const doc = { base64, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'grades.xlsx' };
    const result = ImageHandler.formatDocumentForProvider('anthropic', doc);

    assert.strictEqual(result.type, 'text');
    assert.ok(result.text.includes('grades.xlsx'));
    assert.ok(result.text.includes('Results'));
    assert.ok(result.text.includes('Alice'));
    assert.ok(result.text.includes('95'));
  });

  it('uses default name when document name is missing', () => {
    const base64 = Buffer.from('content').toString('base64');
    const textResult = ImageHandler.formatDocumentForProvider('openai', { base64, mimeType: 'text/plain' });
    assert.ok(textResult.text.includes('--- document ---'));

    const pdfResult = ImageHandler.formatDocumentForProvider('openai', { base64, mimeType: 'application/pdf' });
    assert.ok(pdfResult.text.includes('document.pdf'));
  });
});
