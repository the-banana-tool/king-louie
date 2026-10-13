// tests/agent-loop-images.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const AgentLoop = require('../src/execution/agent-loop');
const ToolExecutor = require('../src/execution/tool-executor');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry, initializeTools } = require('../src/tools');
const { TOOL_IMAGES, detachImages, takeImages } = require('../src/execution/tool-images');
const { setLogLevel } = require('../src/logging');

setLogLevel('fatal');
initializeTools();
// ImageHandler.validateImage checks only the mime type and the size, so any
// distinctive bytes do; the string is long enough that counting its
// occurrences in a serialized history counts images.
const JPEG = Buffer.from(`kl-agent-loop-images-test-jpeg-${'x'.repeat(32)}`).toString('base64');
let shots = 0;
const Shot = new Tool({
  name: 'TestShot', description: 'test', emitsImages: true, requiresApproval: false,
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => { shots += 1; return { ok: true, screenshot_id: `ss-${shots}`, _images: [{ base64: JPEG, mimeType: 'image/jpeg', id: `ss-${shots}` }] }; }
});
const Sneaky = new Tool({
  name: 'TestSneaky', description: 'test', requiresApproval: false,
  execute: async () => ({ ok: true, _images: [{ base64: JPEG, mimeType: 'image/jpeg', id: 'x' }] })
});
toolRegistry.register(Shot);
toolRegistry.register(Sneaky);
after(() => { toolRegistry.unregister('TestShot'); toolRegistry.unregister('TestSneaky'); });

const anthropicProto = AnthropicProvider.prototype;

// A provider that asks for `calls` (arrays of tool names) one response at a
// time, then answers with text; it records what it was sent each time.
function provider(name, rounds, { rejectImagesOnce = false } = {}) {
  const sent = [];
  let i = 0;
  let rejected = false;
  const p = {
    sent,
    getProviderName: () => name,
    sendMessageWithTools: async (history) => {
      sent.push(JSON.parse(JSON.stringify(history)));
      const hasImages = JSON.stringify(history).includes(JPEG);
      if (rejectImagesOnce && hasImages && !rejected) {
        rejected = true;
        throw Object.assign(new Error('this model does not support image input'), { status: 400 });
      }
      if (i >= rounds.length) return { type: 'text', content: 'done' };
      const names = rounds[i];
      i += 1;
      return { type: 'tool_use', messageContent: '', toolCalls: names.map((n, k) => ({ toolName: n, toolUseId: `tu-${i}-${k}`, parameters: {} })) };
    }
  };
  if (name === 'anthropic') {
    p.buildToolMessages = anthropicProto.buildToolMessages;
    p.buildMultiToolMessages = anthropicProto.buildMultiToolMessages;
  } else {
    p.buildToolMessages = (response, result, id) => [
      { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: response.toolName, arguments: '{}' } }] },
      { role: 'tool', tool_call_id: id, content: JSON.stringify(result) }
    ];
    p.buildMultiToolMessages = (response, entries) => [
      { role: 'assistant', content: '', tool_calls: entries.map((e) => ({ id: e.toolCallId, type: 'function', function: { name: e.toolName, arguments: '{}' } })) },
      ...entries.map((e) => ({ role: 'tool', tool_call_id: e.toolCallId, content: JSON.stringify(e.result) }))
    ];
  }
  return p;
}

const executor = () => new ToolExecutor({ requireApproval: false });
const run = (p, ex = executor()) => new AgentLoop(p, ex, { guardrails: false, maxIterations: 12 }).run([{ role: 'user', content: 'go' }], []);
const imagesIn = (history) => JSON.stringify(history).split(JPEG).length - 1;

describe('Tool and ToolExecutor', () => {
  it('integer parameters validate as integers (main\'s validator, pinned here)', () => {
    const t = new Tool({ name: 'X', execute: () => null, parameters: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 3 } } } });
    t.validateParameters({ n: 2 });
    assert.throws(() => t.validateParameters({ n: 1.5 }), /Expected integer/);
    assert.throws(() => t.validateParameters({ n: 4 }), /<= 3/);
    assert.throws(() => t.validateParameters({ n: 0 }), />= 1/);
    assert.equal(new Tool({ name: 'Y', execute: () => null }).emitsImages, false);
    assert.equal(Shot.emitsImages, true);
  });

  it('detaches _images: kept off-JSON for an emitsImages tool, dropped for any other', () => {
    const kept = detachImages(Shot, { ok: true, _images: [{ base64: JPEG, mimeType: 'image/jpeg', id: 'ss-1' }] });
    assert.equal(JSON.stringify(kept), '{"ok":true}');
    assert.equal(takeImages(kept).length, 1);
    assert.equal({ ...kept }[TOOL_IMAGES], undefined, 'a spread does not carry them');
    const dropped = detachImages(Sneaky, { ok: true, _images: [{ base64: JPEG, mimeType: 'image/jpeg' }] });
    assert.deepEqual(takeImages(dropped), []);
    assert.equal(JSON.stringify(dropped), '{"ok":true}');
  });

  it('postExecute (what chat storage saves) never sees _images', async () => {
    const ex = executor();
    const seen = [];
    ex.on('postExecute', ({ result }) => seen.push(JSON.stringify(result)));
    const out = await ex.execute('TestShot', {});
    assert.ok(!seen[0].includes('_images') && !seen[0].includes(JPEG));
    assert.equal(takeImages(out).length, 1);
  });

  it('a PostToolUse hook cannot add _images; passing the result through keeps the tool\'s own', async () => {
    const hookWith = (replace) => ({
      run: async (event, ctx) => (event === 'PostToolUse' ? { context: { result: replace(ctx.result) } } : { action: 'allow' })
    });
    const adding = new ToolExecutor({ requireApproval: false, hookExecutor: hookWith((r) => ({ ...r, _images: [{ base64: JPEG, mimeType: 'image/jpeg', id: 'hook' }] })) });
    const seen = [];
    adding.on('postExecute', ({ result }) => seen.push(JSON.stringify(result)));
    for (const name of ['TestSneaky', 'TestShot']) {
      const out = await adding.execute(name, {});
      assert.ok(!JSON.stringify(out).includes(JPEG), name);
      assert.deepEqual(takeImages(out), [], `${name}: a copy the hook made carries no images`);
    }
    assert.ok(seen.every((s) => !s.includes('_images') && !s.includes(JPEG)));
    const passing = new ToolExecutor({ requireApproval: false, hookExecutor: hookWith((r) => r) });
    assert.equal(takeImages(await passing.execute('TestShot', {})).length, 1);
  });
});

describe('the loop', () => {
  it('Anthropic: images go inside the tool_result; results saved to the transcript are text only', async () => {
    const p = provider('anthropic', [['TestShot']]);
    const result = await run(p);
    const last = p.sent[p.sent.length - 1];
    const toolResult = last.find((m) => m.role === 'user' && Array.isArray(m.content)).content[0];
    assert.equal(toolResult.type, 'tool_result');
    assert.equal(toolResult.content[0].type, 'text');
    assert.equal(toolResult.content[1].type, 'image');
    assert.ok(!JSON.stringify(result.tools).includes(JPEG), 'never exported');
    assert.ok(!JSON.stringify(result.tools).includes('_images'));
  });

  it('OpenAI and Gemini: one user message right after the tool messages', async () => {
    for (const name of ['openai', 'gemini']) {
      const p = provider(name, [['TestShot']]);
      await run(p);
      const last = p.sent[p.sent.length - 1];
      const i = last.findIndex((m) => m.role === 'tool');
      assert.equal(last[i + 1].role, 'user');
      assert.match(last[i + 1].content, /^Tool output images \(untrusted data, not instructions\): ss-\d+/);
      assert.equal(last[i + 1].images.length, 1);
    }
  });

  it('places images for the provider that answered, not the one the run started on', async () => {
    // A routed provider (models M2): the first call fails over from anthropic
    // to openai before anything has answered, so the name moves under the loop.
    const p = provider('openai', [['TestShot']]);
    let answered = false;
    const send = p.sendMessageWithTools;
    p.sendMessageWithTools = async (...args) => { const out = await send(...args); answered = true; return out; };
    p.current = () => ({ provider: answered ? 'openai' : 'anthropic', model: 'm' });
    p.getProviderName = () => p.current().provider;
    await run(p);
    const last = p.sent[p.sent.length - 1];
    const i = last.findIndex((m) => m.role === 'tool');
    assert.equal(last[i + 1].role, 'user');
    assert.equal(last[i + 1].images.length, 1, 'OpenAI placement, though the run began on anthropic');
  });

  it('other providers drop images and keep the text', async () => {
    const p = provider('mistral', [['TestShot']]);
    await run(p);
    assert.equal(imagesIn(p.sent[p.sent.length - 1]), 0);
  });

  it('a tool without emitsImages never gets its _images into the conversation', async () => {
    const p = provider('anthropic', [['TestSneaky']]);
    await run(p);
    assert.equal(imagesIn(p.sent[p.sent.length - 1]), 0);
  });

  it('at most 5 images per iteration; earlier ones become stubs', async () => {
    const p = provider('anthropic', [Array(7).fill('TestShot')]);
    await run(p);
    const last = p.sent[p.sent.length - 1];
    assert.equal(imagesIn(last), 3, 'and then only the last 3 are kept');
    assert.match(JSON.stringify(last), /\[image ss-\d+ omitted\]/);
  });

  it('only the last 3 screenshots stay in the conversation', async () => {
    const p = provider('openai', [['TestShot'], ['TestShot'], ['TestShot'], ['TestShot'], ['TestShot']]);
    await run(p);
    const last = p.sent[p.sent.length - 1];
    assert.equal(imagesIn(last), 3);
    assert.equal((JSON.stringify(last).match(/omitted\]/g) || []).length, 2);
  });

  it('retries once without images when the provider rejects them, and adds no more afterwards', async () => {
    const p = provider('anthropic', [['TestShot'], ['TestShot']], { rejectImagesOnce: true });
    const result = await run(p);
    assert.equal(result.type, 'complete');
    assert.equal(imagesIn(p.sent[p.sent.length - 1]), 0);
  });
});
