// tests/models-capabilities.test.js
// The catalog replaces InferenceRouter.getCapabilities (spec 2026-09-27
// §4.5), whose guesses were stale (Claude 4 counted as non-vision, Ollama
// tool calling guessed from the model name).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { capabilitiesOf } = require('../src/models/capabilities');
const InferenceRouter = require('../src/providers/inference-router');
const { fixtureCatalog } = require('./helpers/models-fixture');
const { localEntry } = require('../src/models/normalize');

const catalog = fixtureCatalog();
const caps = (p, m) => capabilitiesOf(catalog, p, m);

describe('capabilitiesOf', () => {
  it('reads vision and tool calling from the catalog entry', () => {
    assert.deepStrictEqual(caps('anthropic', 'claude-sonnet-4-5'), { vision: true, toolCalling: true, streaming: true, pdfInput: true });
    assert.deepStrictEqual(caps('openai', 'gpt-4o'), { vision: true, toolCalling: true, streaming: true, pdfInput: false });
    assert.deepStrictEqual(caps('openai', 'gpt-3.5-turbo'), { vision: false, toolCalling: true, streaming: true, pdfInput: false });
    assert.deepStrictEqual(caps('groq', 'llama-vision-preview'), { vision: true, toolCalling: false, streaming: true, pdfInput: false });
  });

  it('gives PDF input only to PDF-reading models of Anthropic and Gemini', () => {
    assert.strictEqual(caps('gemini', 'gemini-2.5-pro').pdfInput, true);
    assert.strictEqual(caps('openai', 'gpt-5.5').pdfInput, false, 'the catalog says pdf, but ImageHandler sends OpenAI page images');
  });

  it('reports what Ollama itself says, not a guess from the name', () => {
    const local = fixtureCatalog();
    local.setLocalModels('ollama', [localEntry('ollama', { id: 'llama3.1:8b', toolCall: false }), localEntry('ollama', { id: 'qwen2.5:7b', toolCall: true })]);
    assert.strictEqual(capabilitiesOf(local, 'ollama', 'llama3.1:8b').toolCalling, false);
    assert.strictEqual(capabilitiesOf(local, 'ollama', 'qwen2.5:7b').toolCalling, true);
  });

  it('does not refuse an unknown model, and never claims it sees images', () => {
    assert.deepStrictEqual(caps('openai', 'my-finetune'), { vision: false, toolCalling: true, streaming: true, pdfInput: false });
    assert.deepStrictEqual(caps('anthropic', ''), { vision: false, toolCalling: true, streaming: true, pdfInput: false });
    assert.deepStrictEqual(capabilitiesOf(null, 'openai', 'gpt-4o'), { vision: false, toolCalling: true, streaming: true, pdfInput: false });
  });

  it('the router no longer guesses capabilities', () => {
    assert.strictEqual(typeof new InferenceRouter({ getSettings: () => ({}) }).getCapabilities, 'undefined');
  });
});
