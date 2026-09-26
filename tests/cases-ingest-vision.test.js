// tests/cases-ingest-vision.test.js
// Vision for ingest (cases stage 7 spec §3.2, §3.4; R45): capabilities,
// eligibility, the OCR model choice, the attachment sent, and callModel.
const { describe, it, afterEach, after } = require('node:test');
const assert = require('node:assert');
const { PDFDocument } = require('pdf-lib');
const InferenceRouter = require('../src/providers/inference-router');
const OpenAIProvider = require('../src/providers/openai-provider');
const AnthropicProvider = require('../src/providers/anthropic-provider');
const {
  IMAGE_FORWARDING_PROVIDERS, isVisionEligible, pickOcrModel, pageAttachment, ocrUserText, NO_VISION_MESSAGE, OCR_SYSTEM
} = require('../src/cases/ingest/vision');
const { createCallModel, MAX_REPLY_CHARS } = require('../src/cases/ingest/call-model');
const { openPdf } = require('../src/cases/ingest/pdf');
const { shutdownPdfSandbox } = require('../src/cases/ingest/pdf-sandbox');
const { IngestError } = require('../src/cases/ingest/errors');
const { makePdf, tinyJpeg } = require('./helpers/ingest-fixtures');

after(() => shutdownPdfSandbox());

const router = new InferenceRouter({ getSettings: () => ({}) });
const caps = (p, m) => router.getCapabilities(p, m);

describe('InferenceRouter.getCapabilities (cases stage 7 fix)', () => {
  it('marks current Anthropic models as vision-capable, not only claude-3 names', () => {
    assert.strictEqual(caps('anthropic', 'claude-sonnet-4-5').vision, true);
    assert.strictEqual(caps('anthropic', 'claude-3-5-sonnet-latest').vision, true);
    assert.strictEqual(caps('anthropic', 'claude-2.1').vision, false);
    assert.strictEqual(caps('anthropic', 'claude-instant-1.2').vision, false);
  });

  it('adds pdfInput for vision models of Anthropic and Gemini only', () => {
    assert.strictEqual(caps('anthropic', 'claude-sonnet-4-5').pdfInput, true);
    assert.strictEqual(caps('gemini', 'gemini-2.5-pro').pdfInput, true);
    assert.strictEqual(caps('openai', 'gpt-4o').pdfInput, false);
    assert.strictEqual(caps('anthropic', 'claude-2.1').pdfInput, false);
    assert.strictEqual(caps('openai', 'gpt-4o').vision, true);
  });

  it('leaves every capability it had before unchanged (outputs taken from the code before this change)', () => {
    // [provider, model, vision, toolCalling, streaming] as the router
    // reported them before stage 7; only pdfInput is new.
    const before = [
      ['openai', 'gpt-4o', true, true, true],
      ['openai', 'gpt-4.1-mini', true, true, true],
      ['openai', 'o1', true, true, true],
      ['openai', 'gpt-5', false, true, true],
      ['openai', 'o3', false, true, true],
      ['openai', 'o4-mini', false, true, true],
      ['openai', 'gpt-3.5-turbo', false, true, true],
      ['anthropic', 'claude-3-5-sonnet-latest', true, true, true],
      ['anthropic', 'claude-3-haiku-20240307', true, true, true],
      ['gemini', 'gemini-2.5-pro', true, true, true],
      ['gemini', 'gemini-2.5-flash', true, true, true],
      ['openrouter', 'any-model', true, true, true],
      ['groq', 'llama-vision-preview', true, true, true],
      ['groq', 'llama-3.3-70b', false, true, true],
      ['ollama', 'llama3.1', false, true, true],
      ['ollama', 'qwen2.5', false, false, true],
      ['xai', 'grok-4', false, true, true],
      ['', '', false, true, true]
    ];
    for (const [p, m, vision, toolCalling, streaming] of before) {
      const c = caps(p, m);
      assert.deepStrictEqual(Object.keys(c), ['vision', 'toolCalling', 'streaming', 'pdfInput'], `${p}/${m}`);
      assert.deepStrictEqual({ vision: c.vision, toolCalling: c.toolCalling, streaming: c.streaming }, { vision, toolCalling, streaming }, `${p}/${m}`);
      assert.strictEqual(c.pdfInput, vision && (p === 'anthropic' || p === 'gemini'), `${p}/${m}`);
    }
  });
});

describe('vision eligibility', () => {
  it('needs the vision capability and an image-forwarding provider', () => {
    assert.deepStrictEqual([...IMAGE_FORWARDING_PROVIDERS], ['anthropic', 'openai', 'gemini']);
    assert.strictEqual(isVisionEligible(caps, { provider: 'anthropic', model: 'claude-sonnet-4-5' }), true);
    assert.strictEqual(isVisionEligible(caps, { provider: 'openai', model: 'gpt-4o' }), true);
    // The router says these see images, but ImageHandler does not format
    // attachments for them, so the image would never arrive.
    assert.strictEqual(caps('openrouter', 'any-model').vision, true);
    assert.strictEqual(isVisionEligible(caps, { provider: 'openrouter', model: 'any-model' }), false);
    assert.strictEqual(caps('groq', 'llama-vision-preview').vision, true);
    assert.strictEqual(isVisionEligible(caps, { provider: 'groq', model: 'llama-vision-preview' }), false);
    assert.strictEqual(isVisionEligible(caps, { provider: 'openai', model: 'gpt-3.5-turbo' }), false);
  });

  it('fails closed: no model, no capability function, a throwing or truthy-but-not-true capability', () => {
    // The router reports vision for an empty Anthropic model name.
    assert.strictEqual(caps('anthropic', '').vision, true);
    assert.strictEqual(isVisionEligible(caps, { provider: 'anthropic', model: '' }), false);
    assert.strictEqual(isVisionEligible(null, { provider: 'anthropic', model: 'claude-sonnet-4-5' }), false);
    assert.strictEqual(isVisionEligible(() => { throw new Error('x'); }, { provider: 'anthropic', model: 'm' }), false);
    assert.strictEqual(isVisionEligible(() => ({ vision: 'yes' }), { provider: 'anthropic', model: 'm' }), false);
    assert.strictEqual(isVisionEligible(caps, null), false);
  });

  it('picks cases.ingest.vision, then draft, then judge, else NO_VISION_MODEL', () => {
    const roles = { draft: { provider: 'groq', model: 'llama-3.3-70b' }, judge: { provider: 'gemini', model: 'gemini-2.5-pro' } };
    const roleModel = (role) => roles[role];
    assert.deepStrictEqual(pickOcrModel({ getCapabilities: caps, configured: { provider: 'openai', model: 'gpt-4o' }, roleModel }), { provider: 'openai', model: 'gpt-4o' });
    assert.deepStrictEqual(pickOcrModel({ getCapabilities: caps, configured: { provider: '', model: '' }, roleModel }), { provider: 'gemini', model: 'gemini-2.5-pro' });
    assert.deepStrictEqual(pickOcrModel({ getCapabilities: caps, configured: { provider: 'groq', model: 'x' }, roleModel }), { provider: 'gemini', model: 'gemini-2.5-pro' });
    assert.throws(
      () => pickOcrModel({ getCapabilities: caps, configured: {}, roleModel: () => ({ provider: 'openrouter', model: 'x' }) }),
      (err) => err.code === 'NO_VISION_MODEL' && err.message === NO_VISION_MESSAGE
    );
  });

  it('skips a role lookup that throws', () => {
    const roleModel = (role) => {
      if (role === 'draft') throw new Error('no case');
      return { provider: 'anthropic', model: 'claude-sonnet-4-5' };
    };
    assert.deepStrictEqual(pickOcrModel({ getCapabilities: caps, configured: null, roleModel }), { provider: 'anthropic', model: 'claude-sonnet-4-5' });
  });
});

// A JPEG header padded with comment segments past 5 MB: pdf-lib embeds it,
// and the page is one DCT image larger than the vision image limit.
function bigJpeg() {
  const seg = Buffer.alloc(65535 + 2);
  seg.writeUInt16BE(0xfffe, 0);
  seg.writeUInt16BE(65535, 2);
  const parts = [Buffer.from([0xff, 0xd8])];
  for (let i = 0; i < 82; i += 1) parts.push(seg);
  parts.push(Buffer.from(tinyJpeg()).subarray(2));
  return Buffer.concat(parts);
}

describe('pageAttachment', () => {
  it('sends the one-page PDF to a pdfInput model', async () => {
    const pdf = await openPdf(await makePdf({ pages: [{ text: 'one' }, { scan: true }] }));
    try {
      const att = await pageAttachment({ getCapabilities: caps, sel: { provider: 'anthropic', model: 'claude-sonnet-4-5' }, pdf, n: 2 });
      assert.strictEqual(att.documents.length, 1);
      assert.strictEqual(att.documents[0].mimeType, 'application/pdf');
      assert.ok(Buffer.from(att.documents[0].base64, 'base64').subarray(0, 5).equals(Buffer.from('%PDF-')));
    } finally {
      await pdf.close();
    }
  });

  it('sends the page image to a model without pdfInput, and refuses when there is none', async () => {
    const pdf = await openPdf(await makePdf({ pages: [{ scan: true }, { text: 'typed words only' }] }));
    try {
      const openai = { provider: 'openai', model: 'gpt-4o' };
      const img = await pageAttachment({ getCapabilities: caps, sel: openai, pdf, n: 1 });
      assert.deepStrictEqual(img, { images: [{ mimeType: 'image/jpeg', base64: Buffer.from(tinyJpeg()).toString('base64') }] });
      assert.deepStrictEqual(await pageAttachment({ getCapabilities: caps, sel: openai, pdf, n: 2 }), {
        error: 'no PDF-capable vision model and the page is not a single image'
      });
    } finally {
      await pdf.close();
    }
  });

  it('sends an image file as an image and refuses one over 5 MB', async () => {
    const sel = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
    const small = await pageAttachment({ getCapabilities: caps, sel, image: { mime: 'image/png', bytes: Buffer.from('png') } });
    assert.strictEqual(small.images[0].mimeType, 'image/png');
    const big = await pageAttachment({ getCapabilities: caps, sel, image: { mime: 'image/png', bytes: Buffer.alloc(5 * 1024 * 1024 + 1) } });
    assert.deepStrictEqual(big, { error: 'page too large for vision' });
  });

  it('maps a scan page image over the sandbox cap to "page too large", not a throw', async () => {
    const doc = await PDFDocument.create();
    const jpg = await doc.embedJpg(bigJpeg());
    doc.addPage([420, 300]).drawImage(jpg, { x: 0, y: 0, width: 420, height: 300 });
    const pdf = await openPdf(Buffer.from(await doc.save()));
    try {
      const r = await pageAttachment({ getCapabilities: caps, sel: { provider: 'openai', model: 'gpt-4o' }, pdf, n: 1 });
      assert.deepStrictEqual(r, { error: 'page too large for vision' });
    } finally {
      await pdf.close();
    }
  });

  it('maps an over-cap one-page PDF to "page too large" and rethrows every other reader error', async () => {
    const sel = { provider: 'anthropic', model: 'claude-sonnet-4-5' };
    const tooLarge = Object.assign(new IngestError('UNREADABLE_PDF', 'Cannot read a.pdf: a page is too large to read.'), { tooLarge: true });
    const fake = (err) => ({ singlePagePdf: async () => { throw err; }, pageImage: async () => { throw err; } });
    assert.deepStrictEqual(await pageAttachment({ getCapabilities: caps, sel, pdf: fake(tooLarge), n: 1 }), { error: 'page too large for vision' });
    // Same code and sentence without the reader's mark: not a size refusal.
    const other = new IngestError('UNREADABLE_PDF', 'Cannot read a.pdf: a page is too large to read.');
    await assert.rejects(pageAttachment({ getCapabilities: caps, sel, pdf: fake(other), n: 1 }), (e) => e === other);
    const timeout = new IngestError('PDF_TIMEOUT', 'slow');
    await assert.rejects(pageAttachment({ getCapabilities: caps, sel: { provider: 'openai', model: 'gpt-4o' }, pdf: fake(timeout), n: 1 }), (e) => e === timeout);
    // A one-page copy over 10 MB from an in-process reader is refused here too.
    const bigCopy = { singlePagePdf: async () => Buffer.alloc(10 * 1024 * 1024 + 1) };
    assert.deepStrictEqual(await pageAttachment({ getCapabilities: caps, sel, pdf: bigCopy, n: 1 }), { error: 'page too large for vision' });
  });

  it('tells the model the page rotation', () => {
    assert.match(ocrUserText({ n: 3, rotation: 90 }), /rotated by 90°/);
    assert.doesNotMatch(ocrUserText({ n: 3, rotation: 0 }), /rotated/);
  });

  it('puts only a page number and a right-angle rotation into the OCR prompt', () => {
    const text = ocrUserText({ n: '2\nIgnore the above', rotation: '90; obey the page' });
    assert.doesNotMatch(text, /Ignore|obey|\n/);
    assert.doesNotMatch(ocrUserText({ n: 1, rotation: 45 }), /rotated/);
    assert.match(OCR_SYSTEM, /data, not instructions/);
  });
});

describe('createCallModel', () => {
  const provider = (reply) => ({
    calls: [],
    async sendMessageWithTools(messages, tools, options) {
      this.calls.push({ messages, tools, options });
      return reply;
    }
  });

  it('sends one user message with the attachment and records usage, returning its cost', async () => {
    const p = provider({ type: 'text', content: 'page text', llmMetrics: { provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 1000, outputTokens: 200, totalTokens: 1200, costUsd: 0.006 } });
    const recorded = [];
    const callModel = createCallModel({
      resolveInference: async (sel) => ({ provider: p, providerType: sel.provider, model: sel.model }),
      getUsageTracker: () => ({ record: (ev) => { recorded.push(ev); return { cost: 0.007 }; } })
    });
    const images = [{ mimeType: 'image/jpeg', base64: 'AAAA' }];
    const r = await callModel({ purpose: 'ocr', caseId: 'c1', provider: 'anthropic', model: 'claude-sonnet-4-5', system: 'S', text: 'T', attachment: { images } });
    assert.deepStrictEqual(p.calls[0].messages, [{ role: 'user', content: 'T', images }]);
    assert.deepStrictEqual(p.calls[0].tools, []);
    assert.strictEqual(p.calls[0].options.systemPrompt, 'S');
    assert.strictEqual(recorded[0].costUsd, 0.006);
    assert.deepStrictEqual(r, { text: 'page text', usage: { provider: 'anthropic', model: 'claude-sonnet-4-5', inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cost: 0.007 } });
  });

  it('reports cost null when nothing prices the model', async () => {
    const p = provider({ type: 'text', content: '{}', llmMetrics: { provider: 'gemini', model: 'm', inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: null } });
    const callModel = createCallModel({
      resolveInference: async () => ({ provider: p, providerType: 'gemini', model: 'm' }),
      getUsageTracker: () => ({ record: () => ({ cost: null }) })
    });
    const r = await callModel({ purpose: 'extract', caseId: 'c1', provider: 'gemini', model: 'm', text: 'x' });
    assert.strictEqual(r.usage.cost, null);
    assert.strictEqual(r.usage.totalTokens, 15);
    await assert.rejects(callModel({ purpose: 'chat', caseId: 'c1', provider: 'gemini', model: 'm' }), /Unknown ingest model purpose/);
  });

  it('refuses an OCR call with nothing to read, before any model call', async () => {
    const p = provider({ type: 'text', content: 'invented text' });
    const callModel = createCallModel({ resolveInference: async () => ({ provider: p, providerType: 'openai', model: 'gpt-4o' }) });
    await assert.rejects(callModel({ purpose: 'ocr', caseId: 'c1', provider: 'openai', model: 'gpt-4o', text: 'T' }), (e) => e.code === 'NO_ATTACHMENT');
    await assert.rejects(callModel({ purpose: 'ocr', caseId: 'c1', provider: 'openai', model: 'gpt-4o', text: 'T', attachment: { error: 'page too large for vision' } }), (e) => e.code === 'NO_ATTACHMENT');
    assert.strictEqual(p.calls.length, 0);
  });

  it('caps the reply, and never lets a tracker failure or a bad cost through', async () => {
    const p = provider({ type: 'text', content: 'x'.repeat(MAX_REPLY_CHARS + 50), llmMetrics: { inputTokens: 1, outputTokens: 1, costUsd: -5 } });
    const warnings = [];
    const callModel = createCallModel({
      resolveInference: async () => ({ provider: p, providerType: 'openai', model: 'gpt-4o' }),
      getUsageTracker: () => ({ record: () => { throw new Error('disk full'); } }),
      log: { warn: (m) => warnings.push(m) }
    });
    const r = await callModel({ purpose: 'verify', caseId: 'c1', provider: 'openai', model: 'gpt-4o', text: 'x' });
    assert.strictEqual(r.text.length, MAX_REPLY_CHARS);
    assert.strictEqual(r.usage.cost, null);
    assert.strictEqual(r.usage.totalTokens, 2);
    assert.strictEqual(warnings.length, 2);
    const q = provider({ type: 'text', content: 'ok', llmMetrics: { costUsd: 0.1 } });
    const nanCost = createCallModel({
      resolveInference: async () => ({ provider: q, providerType: 'openai', model: 'gpt-4o' }),
      getUsageTracker: () => ({ record: () => ({ cost: Number.NaN }) })
    });
    assert.strictEqual((await nanCost({ purpose: 'verify', caseId: 'c1', provider: 'openai', model: 'gpt-4o', text: 'x' })).usage.cost, null);
  });
});

describe('providers accept a call with no tools', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  const capture = (json) => {
    const bodies = [];
    global.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => json };
    };
    return bodies;
  };
  const captureRaw = (json) => {
    const bodies = [];
    global.fetch = async (_url, init) => {
      bodies.push(init.body);
      return { ok: true, json: async () => json };
    };
    return bodies;
  };

  it('OpenAI omits tools and tool_choice when there are none', async () => {
    const bodies = capture({ model: 'gpt-4o', choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    const r = await new OpenAIProvider('test-key-minimum-length').sendMessageWithTools([{ role: 'user', content: 'hi' }], [], { model: 'gpt-4o' });
    assert.strictEqual(r.content, 'ok');
    assert.ok(!('tools' in bodies[0]) && !('tool_choice' in bodies[0]));
  });

  it('Anthropic omits tools when there are none', async () => {
    const bodies = capture({ model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 3, output_tokens: 1 } });
    const r = await new AnthropicProvider('test-key-minimum-length').sendMessageWithTools([{ role: 'user', content: 'hi' }], [], { model: 'claude-sonnet-4-5' });
    assert.strictEqual(r.content, 'ok');
    assert.ok(!('tools' in bodies[0]));
  });

  // Request bodies for a normal tool call, byte for byte as the providers
  // sent them before stage 7 (captured from the code at 222bb20).
  const TOOLS = [
    { name: 'ToolSearch', description: 'Find tools', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
    { name: 'Read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }
  ];
  const MSGS = [{ role: 'user', content: 'hi' }];
  const REPLY = { model: 'm', choices: [{ message: { content: 'ok' } }], content: [{ type: 'text', text: 'ok' }], output: [], usage: {} };

  it('OpenAI sends a non-empty tool list exactly as before (chat completions and responses)', async () => {
    const bodies = captureRaw(REPLY);
    const o = new OpenAIProvider('test-key-minimum-length');
    await o.sendMessageWithTools(MSGS, TOOLS, { model: 'gpt-4o', systemPrompt: 'S' });
    await o._sendResponsesWithTools('gpt-4o', MSGS, TOOLS, {});
    assert.strictEqual(bodies[0], '{"model":"gpt-4o","messages":[{"role":"system","content":"S"},{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"ToolSearch","description":"Find tools","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}}},{"type":"function","function":{"name":"Read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}],"tool_choice":"auto","temperature":0.7,"stream":false}');
    assert.strictEqual(bodies[1], '{"model":"gpt-4o","input":[{"role":"user","content":"hi"}],"tools":[{"type":"function","name":"ToolSearch","description":"Find tools","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}},{"type":"function","name":"Read","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}],"temperature":0.7}');
  });

  it('OpenAI responses omits tools when there are none', async () => {
    const bodies = capture(REPLY);
    await new OpenAIProvider('test-key-minimum-length')._sendResponsesWithTools('gpt-4o', MSGS, [], {});
    assert.ok(!('tools' in bodies[0]));
  });

  it('Anthropic sends a non-empty tool list exactly as before', async () => {
    const bodies = captureRaw(REPLY);
    await new AnthropicProvider('test-key-minimum-length').sendMessageWithTools(MSGS, TOOLS, { model: 'claude-sonnet-4-5', systemPrompt: 'S' });
    assert.strictEqual(bodies[0], '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"hi"}],"system":[{"type":"text","text":"S","cache_control":{"type":"ephemeral"}}],"tools":[{"name":"ToolSearch","description":"Find tools","input_schema":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]},"cache_control":{"type":"ephemeral"}},{"name":"Read","description":"Read a file","input_schema":{"type":"object","properties":{"path":{"type":"string"}}},"cache_control":{"type":"ephemeral"}}],"max_tokens":4096,"stream":false,"temperature":0.7}');
  });
});
