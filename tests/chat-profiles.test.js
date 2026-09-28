// tests/chat-profiles.test.js
// The chat turn on profiles (spec 2026-09-27 §6.5–§6.7, §15): models frozen
// at launch, the main gate and its messages, an unusable override, and
// failover along main's list — any provider on the first call only.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { chatHarness } = require('./helpers/chat-harness');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const t = (provider, model) => ({ provider, model, effort: null });
const errorEvent = (h) => h.sent.find((e) => e.channel === 'chat:messageError')?.payload;

function verdicts(unusable = {}) {
  return {
    ensureTested: async () => ({ ok: true }),
    explain: (p, m) => (unusable[`${p}/${m}`] ? { usable: false, reasons: [unusable[`${p}/${m}`]], notes: [] } : { usable: true, reasons: [], notes: [] })
  };
}

describe('chat turns on profiles', () => {
  it('a main switch during a run applies to the next turn', async () => {
    const seen = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const provider = {
      sendMessageWithTools: async (_messages, _tools, opts) => {
        calls += 1;
        seen.push(opts.model);
        if (calls === 1) {
          // Pause on the turn's first call, so the test can switch the main
          // override while the turn is still running; the tool_use makes
          // the loop call again inside the same turn, which is what proves
          // the switch didn't reach the run already in flight.
          await gate;
          return { type: 'tool_use', toolName: 'Read', toolUseId: 't1', parameters: { file_path: 'notes.txt' } };
        }
        return { type: 'text', content: `answered by ${opts.model}` };
      }
    };
    const h = chatHarness({ provider, model: 'model-a' });
    const first = h.send({ agentMode: true, message: 'first' });
    while (!seen.length) await tick();
    h.chat.mainOverride = t('openai', 'model-b');
    release();
    await first;
    // The turn's own second call (after the tool ran) still used model-a:
    // the switch made mid-run did not reach the run already in flight.
    assert.deepStrictEqual(seen, ['model-a', 'model-a']);
    await h.send({ agentMode: true, message: 'second' });
    assert.deepStrictEqual(seen, ['model-a', 'model-a', 'model-b']);
    const replies = h.chat.messages.filter((m) => m.sender === 'assistant').map((m) => m.text);
    assert.deepStrictEqual(replies.slice(-2), ['answered by model-a', 'answered by model-b']);
  });

  it('an unusable main override fails the turn with the reason and a one-click action, never a silent switch', async () => {
    let called = false;
    const provider = { streamMessage: async () => { called = true; return {}; } };
    const h = chatHarness({ provider, model: 'gpt-5.5', overrides: { getAvailability: () => verdicts({ 'groq/llama-3.3-70b': 'Groq connection test failed: Invalid API Key' }) } });
    h.chat.mainOverride = t('groq', 'llama-3.3-70b');
    const result = await h.send({ agentMode: false });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /The main model override groq\/llama-3\.3-70b is not usable: Groq connection test failed: Invalid API Key/);
    assert.deepStrictEqual(errorEvent(h).action, { kind: 'use-profile-main' });
    assert.strictEqual(called, false);
  });

  it('no usable main fails before any call, listing every skipped target and its reason', async () => {
    let called = false;
    const provider = { streamMessage: async () => { called = true; return {}; } };
    const h = chatHarness({
      provider,
      roles: { main: [t('groq', 'a'), t('openai', 'b')] },
      overrides: { getAvailability: () => verdicts({ 'groq/a': 'No token saved for Groq.', 'openai/b': 'OpenAI connection test failed: timeout' }) }
    });
    const result = await h.send({ agentMode: false });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /No usable model for main in the profile "Test profile"\. Skipped: groq\/a \(No token saved for Groq\.\); openai\/b \(OpenAI connection test failed: timeout\)/);
    assert.deepStrictEqual(errorEvent(h).action, { kind: 'open-models' });
    assert.strictEqual(called, false);
  });

  it('an empty main points the owner to Models', async () => {
    const h = chatHarness({ provider: {}, roles: { main: [] } });
    const result = await h.send({ agentMode: false });
    assert.match(result.error, /main has no models in the profile "Test profile"\. Add one in Settings → Models/);
  });

  it('fails over along main on the turn\'s first call, to another provider', async () => {
    const providers = {
      groq: { streamMessage: async () => { throw new Error('upstream exploded'); } },
      openai: {
        streamMessage: async (_messages, opts, onChunk) => {
          onChunk('Hello');
          return { llmMetrics: { provider: 'openai', model: opts.model, inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.001 } };
        }
      }
    };
    const h = chatHarness({ providers, roles: { main: [t('groq', 'down'), t('openai', 'up')] } });
    const result = await h.send({ agentMode: false });
    assert.notStrictEqual(result.ok, false, JSON.stringify(result));
    const reply = h.chat.messages[h.chat.messages.length - 1];
    assert.deepStrictEqual([reply.text, reply.llm.calls[0].model], ['Hello', 'up']);
  });

  it('a turn cannot move to another provider after its first call, and says to retry with another model', async () => {
    let openaiCalls = 0;
    let anthropicCalled = false;
    const providers = {
      openai: {
        sendMessageWithTools: async () => {
          openaiCalls += 1;
          if (openaiCalls === 1) return { type: 'tool_use', toolName: 'Read', toolUseId: 't1', parameters: { file_path: 'notes.txt' } };
          throw new Error('upstream exploded');
        }
      },
      anthropic: { sendMessageWithTools: async () => { anthropicCalled = true; return { type: 'text', content: 'no' }; } }
    };
    const h = chatHarness({ providers, roles: { main: [t('openai', 'a'), t('anthropic', 'b')] } });
    const result = await h.send({ agentMode: true });
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /cannot move to anthropic\/b after its first model call/);
    assert.match(result.error, /Retry with/);
    assert.strictEqual(anthropicCalled, false);
  });

  it('the advisor reviews on the turn\'s main model', async () => {
    const models = [];
    const provider = {
      sendMessageWithTools: async (_m, _t, opts) => { models.push(['loop', opts.model]); return { type: 'text', content: 'done' }; },
      sendMessage: async (_m, opts) => { models.push(['advisor', opts.model]); return 'VERDICT: approve\nLooks right.'; }
    };
    const h = chatHarness({ provider, model: 'gpt-5.5', overrides: { getSettings: () => ({ advisor: { enabled: true } }) } });
    await h.send({ agentMode: true });
    assert.ok(models.some(([who, m]) => who === 'advisor' && m === 'gpt-5.5'), JSON.stringify(models));
  });
});
