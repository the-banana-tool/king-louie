// tests/chat-system-dynamic.test.js
// The send path's stable/dynamic prompt split (recall spec §6.5).
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { chatHarness } = require('./helpers/chat-harness');

const capturing = (sink) => ({
  sendMessageWithTools: async (_m, _t, options) => { sink.options = options; return { type: 'text', content: 'done' }; }
});

describe('send path: stable and dynamic system prompt', () => {
  it('keeps memory context out of the stable, cached part', async () => {
    const sink = {};
    const assembler = {
      assemble: async (_message, opts) => ({ systemPrompt: `ASSEMBLED${opts.memoryContext || ''}`, tools: [{ name: 'Read', description: 'r', input_schema: { type: 'object', properties: {} } }], availableToolNames: [] })
    };
    const h = chatHarness({
      provider: capturing(sink),
      overrides: { getContextAssembler: () => assembler, buildMemoryContextSection: async () => 'MEMORY-CONTEXT' }
    });
    await h.send({ agentMode: true });
    assert.strictEqual(sink.options.systemPrompt, 'ASSEMBLED');
    assert.strictEqual(sink.options.systemPromptDynamic, 'MEMORY-CONTEXT');
  });

  it('without an assembler the stable part is the runtime prompt alone', async () => {
    const sink = {};
    const h = chatHarness({ provider: capturing(sink), overrides: { buildMemoryContextSection: async () => 'MEMORY-CONTEXT' } });
    await h.send({ agentMode: true });
    assert.strictEqual(sink.options.systemPrompt, 'BASE-PROMPT');
    assert.strictEqual(sink.options.systemPromptDynamic, 'MEMORY-CONTEXT');
  });

  it('no memory context and no case: no dynamic part', async () => {
    const sink = {};
    const h = chatHarness({ provider: capturing(sink) });
    await h.send({ agentMode: true });
    assert.strictEqual(sink.options.systemPromptDynamic, undefined);
  });
});
