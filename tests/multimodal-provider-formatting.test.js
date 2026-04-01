const { describe, it } = require('node:test');
const assert = require('node:assert');

const OpenAIProvider = require('../src/providers/openai-provider');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const GeminiProvider = require('../src/providers/gemini-provider');

describe('Provider multimodal formatting', () => {
  it('OpenAIProvider formats user text+image as multimodal content array', () => {
    const provider = new OpenAIProvider('test-key-minimum-length');
    const imageBase64 = Buffer.from('tiny-image').toString('base64');

    const messages = provider.formatMessages([
      {
        sender: 'user',
        text: 'What is in this image?',
        images: [{ base64: imageBase64, mimeType: 'image/png', name: 'tiny.png' }]
      }
    ]);

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].role, 'user');
    assert.ok(Array.isArray(messages[0].content));
    assert.deepStrictEqual(messages[0].content[0], { type: 'text', text: 'What is in this image?' });
    assert.deepStrictEqual(messages[0].content[1], {
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${imageBase64}`
      }
    });
  });

  it('AnthropicProvider formats user text+image as content blocks', () => {
    const provider = new AnthropicProvider('test-key-minimum-length');
    const imageBase64 = Buffer.from('tiny-image').toString('base64');

    const messages = provider.formatMessages([
      {
        sender: 'user',
        text: 'Analyze this image',
        images: [{ base64: imageBase64, mimeType: 'image/png', name: 'tiny.png' }]
      }
    ]);

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].role, 'user');
    assert.ok(Array.isArray(messages[0].content));
    assert.deepStrictEqual(messages[0].content[0], { type: 'text', text: 'Analyze this image' });
    assert.deepStrictEqual(messages[0].content[1], {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: imageBase64
      }
    });
  });

  it('OpenAIProvider supports image-only user messages', () => {
    const provider = new OpenAIProvider('test-key-minimum-length');
    const imageBase64 = Buffer.from('tiny-image').toString('base64');

    const messages = provider.formatMessages([
      {
        sender: 'user',
        text: '',
        images: [{ base64: imageBase64, mimeType: 'image/png' }]
      }
    ]);

    assert.strictEqual(messages.length, 1);
    assert.ok(Array.isArray(messages[0].content));
    assert.strictEqual(messages[0].content.length, 1);
    assert.strictEqual(messages[0].content[0].type, 'image_url');
  });

  // --- Document formatting through providers ---

  it('AnthropicProvider formats text document as content block', () => {
    const provider = new AnthropicProvider('test-key-minimum-length');
    const docBase64 = Buffer.from('Hello from file').toString('base64');

    const messages = provider.formatMessages([
      {
        sender: 'user',
        text: 'Summarize this',
        documents: [{ base64: docBase64, mimeType: 'text/plain', name: 'notes.txt', textContent: 'Hello from file' }]
      }
    ]);

    assert.strictEqual(messages.length, 1);
    assert.ok(Array.isArray(messages[0].content));
    assert.strictEqual(messages[0].content[0].type, 'text');
    assert.strictEqual(messages[0].content[0].text, 'Summarize this');
    assert.strictEqual(messages[0].content[1].type, 'text');
    assert.ok(messages[0].content[1].text.includes('Hello from file'));
    assert.ok(messages[0].content[1].text.includes('notes.txt'));
  });

  it('AnthropicProvider formats PDF as native document type', () => {
    const provider = new AnthropicProvider('test-key-minimum-length');
    const pdfBase64 = Buffer.from('fake-pdf-content').toString('base64');

    const messages = provider.formatMessages([
      {
        sender: 'user',
        text: 'Read this PDF',
        documents: [{ base64: pdfBase64, mimeType: 'application/pdf', name: 'report.pdf' }]
      }
    ]);

    assert.strictEqual(messages.length, 1);
    assert.ok(Array.isArray(messages[0].content));
    const docBlock = messages[0].content.find((b) => b.type === 'document');
    assert.ok(docBlock, 'should have a document block');
    assert.strictEqual(docBlock.source.media_type, 'application/pdf');
    assert.strictEqual(docBlock.source.data, pdfBase64);
  });

  it('OpenAIProvider formats text document as text content block', () => {
    const provider = new OpenAIProvider('test-key-minimum-length');
    const docBase64 = Buffer.from('CSV data here').toString('base64');

    const messages = provider.formatMessages([
      {
        sender: 'user',
        text: 'Analyze this CSV',
        documents: [{ base64: docBase64, mimeType: 'text/csv', name: 'data.csv', textContent: 'CSV data here' }]
      }
    ]);

    assert.strictEqual(messages.length, 1);
    assert.ok(Array.isArray(messages[0].content));
    assert.strictEqual(messages[0].content[0].type, 'text');
    assert.strictEqual(messages[0].content[0].text, 'Analyze this CSV');
    assert.strictEqual(messages[0].content[1].type, 'text');
    assert.ok(messages[0].content[1].text.includes('CSV data here'));
  });

  it('GeminiProvider formats text document as text part', () => {
    const provider = new GeminiProvider('test-key-minimum-length');
    const docBase64 = Buffer.from('Markdown content').toString('base64');

    const result = provider.formatMessages([
      {
        sender: 'user',
        text: 'Review this',
        documents: [{ base64: docBase64, mimeType: 'text/markdown', name: 'readme.md', textContent: 'Markdown content' }]
      }
    ]);

    assert.ok(result.contents.length >= 1);
    const userMsg = result.contents.find((m) => m.role === 'user');
    assert.ok(userMsg);
    const textParts = userMsg.parts.filter((p) => p.text);
    assert.ok(textParts.some((p) => p.text === 'Review this'));
    assert.ok(textParts.some((p) => p.text.includes('Markdown content')));
  });

  it('GeminiProvider formats PDF as inlineData part', () => {
    const provider = new GeminiProvider('test-key-minimum-length');
    const pdfBase64 = Buffer.from('fake-pdf').toString('base64');

    const result = provider.formatMessages([
      {
        sender: 'user',
        text: 'Read this',
        documents: [{ base64: pdfBase64, mimeType: 'application/pdf', name: 'doc.pdf' }]
      }
    ]);

    const userMsg = result.contents.find((m) => m.role === 'user');
    assert.ok(userMsg);
    const pdfPart = userMsg.parts.find((p) => p.inlineData);
    assert.ok(pdfPart, 'should have inlineData part for PDF');
    assert.strictEqual(pdfPart.inlineData.mimeType, 'application/pdf');
  });

  it('providers handle text + images + documents together', () => {
    const provider = new AnthropicProvider('test-key-minimum-length');
    const imageBase64 = Buffer.from('tiny-image').toString('base64');
    const docBase64 = Buffer.from('file content').toString('base64');

    const messages = provider.formatMessages([
      {
        sender: 'user',
        text: 'Analyze all of this',
        images: [{ base64: imageBase64, mimeType: 'image/png', name: 'photo.png' }],
        documents: [{ base64: docBase64, mimeType: 'text/plain', name: 'notes.txt', textContent: 'file content' }]
      }
    ]);

    assert.strictEqual(messages.length, 1);
    assert.ok(Array.isArray(messages[0].content));
    const types = messages[0].content.map((b) => b.type);
    assert.ok(types.includes('text'), 'should have text block');
    assert.ok(types.includes('image'), 'should have image block');
    // documents come as text blocks, so we should have at least 2 text blocks
    const textBlocks = messages[0].content.filter((b) => b.type === 'text');
    assert.ok(textBlocks.length >= 2, 'should have user text + document text');
    assert.ok(textBlocks.some((b) => b.text.includes('file content')));
  });

  it('providers return plain string when no images or documents', () => {
    const anthropic = new AnthropicProvider('test-key-minimum-length');
    const openai = new OpenAIProvider('test-key-minimum-length');

    const anthropicMsgs = anthropic.formatMessages([{ sender: 'user', text: 'Hello' }]);
    assert.strictEqual(anthropicMsgs[0].content, 'Hello');

    const openaiMsgs = openai.formatMessages([{ sender: 'user', text: 'Hello' }]);
    assert.strictEqual(openaiMsgs[0].content, 'Hello');
  });

  it('OpenAIProvider handles document-only user messages', () => {
    const provider = new OpenAIProvider('test-key-minimum-length');
    const docBase64 = Buffer.from('Just a doc').toString('base64');

    const messages = provider.formatMessages([
      {
        sender: 'user',
        text: '',
        documents: [{ base64: docBase64, mimeType: 'text/plain', name: 'file.txt', textContent: 'Just a doc' }]
      }
    ]);

    assert.strictEqual(messages.length, 1);
    assert.ok(Array.isArray(messages[0].content));
    assert.strictEqual(messages[0].content.length, 1);
    assert.strictEqual(messages[0].content[0].type, 'text');
    assert.ok(messages[0].content[0].text.includes('Just a doc'));
  });
});
