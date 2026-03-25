const { describe, it } = require('node:test');
const assert = require('node:assert');

const OpenAIProvider = require('../src/providers/openai-provider');
const AnthropicProvider = require('../src/providers/anthropic-provider');

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
});
