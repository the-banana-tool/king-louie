// tests/providers-system-dynamic.test.js
// Stable and dynamic system prompt parts (recall spec §6.5).
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const OpenAIProvider = require('../src/providers/openai-provider');
const AgentLoop = require('../src/execution/agent-loop');

const MSGS = [{ role: 'user', content: 'hi' }];
const REPLY = { model: 'm', choices: [{ message: { content: 'ok' } }], content: [{ type: 'text', text: 'ok' }], usage: {} };

describe('systemPromptDynamic', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const capture = () => {
    const bodies = [];
    global.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => REPLY };
    };
    return bodies;
  };

  it('Anthropic sends two system blocks, cache_control on the stable one only', async () => {
    const bodies = capture();
    const p = new AnthropicProvider('test-key-minimum-length');
    await p.sendMessageWithTools(MSGS, [], { model: 'claude-sonnet-4-5', systemPrompt: 'STABLE', systemPromptDynamic: 'DYNAMIC' });
    await p.sendMessage(MSGS, { model: 'claude-sonnet-4-5', systemPrompt: 'STABLE', systemPromptDynamic: 'DYNAMIC' });
    for (const body of bodies) {
      assert.deepStrictEqual(body.system, [
        { type: 'text', text: 'STABLE', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'DYNAMIC' }
      ]);
    }
  });

  it('Anthropic: dynamic only is one uncached block; neither sends no system', async () => {
    const bodies = capture();
    const p = new AnthropicProvider('test-key-minimum-length');
    await p.sendMessageWithTools(MSGS, [], { model: 'claude-sonnet-4-5', systemPromptDynamic: 'DYNAMIC' });
    await p.sendMessageWithTools(MSGS, [], { model: 'claude-sonnet-4-5' });
    assert.deepStrictEqual(bodies[0].system, [{ type: 'text', text: 'DYNAMIC' }]);
    assert.ok(!('system' in bodies[1]));
  });

  it('every Anthropic request path passes the dynamic part', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'providers', 'anthropic-provider.js'), 'utf8');
    assert.strictEqual((src.match(/buildCachedSystemPrompt\(systemPrompt, options\.systemPromptDynamic\)/g) || []).length, 4);
  });

  it('other providers concatenate stable and dynamic with a blank line', async () => {
    const bodies = capture();
    await new OpenAIProvider('test-key-minimum-length').sendMessageWithTools(MSGS, [], { model: 'gpt-4o', systemPrompt: 'STABLE', systemPromptDynamic: 'DYNAMIC' });
    assert.deepStrictEqual(bodies[0].messages[0], { role: 'system', content: 'STABLE\n\nDYNAMIC' });
    const p = new OpenAIProvider('test-key-minimum-length');
    assert.strictEqual(p.systemText({ systemPrompt: '', systemPromptDynamic: 'D' }), 'D');
    assert.strictEqual(p.systemText({}), '');
  });

  it('no provider but base and Anthropic reads options.systemPrompt directly', () => {
    const dir = path.join(__dirname, '..', 'src', 'providers');
    const offenders = fs.readdirSync(dir)
      .filter((f) => f.endsWith('-provider.js') && !['base-provider.js', 'anthropic-provider.js'].includes(f))
      .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('options.systemPrompt'));
    assert.deepStrictEqual(offenders, []);
  });

  it('AgentLoop passes both parts to the provider untouched', async () => {
    let seen = null;
    const provider = { sendMessageWithTools: async (_m, _t, options) => { seen = options; return { type: 'text', content: 'ok' }; } };
    const loop = new AgentLoop(provider, { execute: async () => ({ ok: true }) }, { maxIterations: 2 });
    await loop.run([{ sender: 'user', text: 'hi' }], [], { systemPrompt: 'STABLE', systemPromptDynamic: 'DYNAMIC' });
    assert.strictEqual(seen.systemPrompt, 'STABLE');
    assert.strictEqual(seen.systemPromptDynamic, 'DYNAMIC');
  });
});
