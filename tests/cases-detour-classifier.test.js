// tests/cases-detour-classifier.test.js
// The detour classifier (cases stage 5 spec §3.3): strict parsing, the
// decision threshold, skips, the cache, failures that fail open, and usage
// charged to the case.
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CaseRuntime } = require('../src/cases');
const { DetourClassifier, CLASSIFY_SYSTEM, parseClassification } = require('../src/cases/detours/classifier');
const { DetourLog } = require('../src/cases/detours/log');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-classify-')); dirs.push(d); return d; };

const DETOUR = '{"onCase":false,"confidence":0.9,"reason":"Fixing the phone agent\'s code does not collect quotes"}';

// A tool registry that resolves every name, like a real one holding the
// wake-up tools (C3 widens that list with WebFetch/WebSearch) and the case
// tools: the classify call must still offer only its fixed ['Read'].
function fakeToolRegistry() {
  return {
    get(name) {
      return { toFunctionDefinition: () => ({ name, description: `${name} tool`, input_schema: { type: 'object', properties: {} } }) };
    }
  };
}

// A host whose router answers with `reply(messages, opts)`.
function host(reply, { token = true } = {}) {
  const calls = [];
  const recorded = [];
  return {
    calls,
    recorded,
    inferenceRouter: {
      async routeWithFallback(tier, messages, opts) {
        calls.push({ tier, messages, opts });
        return reply(messages, opts, calls.length);
      }
    },
    toolRegistry: fakeToolRegistry(),
    hasProviderToken: () => token,
    getUsageTracker: () => ({ record: (e) => { recorded.push(e); return { ...e, cost: e.costUsd }; } })
  };
}

async function activeCase(h, settings = {}) {
  const rt = new CaseRuntime({ root: tmp(), host: h, getSettings: () => ({ cases: settings }) });
  const info = await rt.createCase({ title: 'Rear door quotes', type: 'outreach', objective: 'Three written quotes for the rear door' });
  rt.brief(info.id).update('why', 'The door lets rain in', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', 'Three written quotes', { provenance: 'model' });
  rt.brief(info.id).update('hardConstraints', ['Under 2,000 dollars'], { provenance: 'user' });
  rt.completeGating(info.id);
  const turn = await rt.beginTurn(info.id, { turnId: 'turn-41', source: 'owner', ownerMessage: 'x' });
  return { rt, info, turn, classifier: new DetourClassifier({ runtime: rt }) };
}

const journalLines = (dir) => fs.readdirSync(path.join(dir, 'journal')).filter((n) => n.endsWith('-detour.md') || /-detour-\d+\.md$/.test(n));

describe('parseClassification', () => {
  it('accepts a bare object, one code fence, trailing prose and extra keys', () => {
    const want = { onCase: false, confidence: 0.9, reason: "Fixing the phone agent's code does not collect quotes" };
    assert.deepStrictEqual(parseClassification(DETOUR), want);
    assert.deepStrictEqual(parseClassification(`\`\`\`json\n${DETOUR}\n\`\`\``), want);
    assert.deepStrictEqual(parseClassification(`${DETOUR}\nHope that helps.`), want);
    assert.deepStrictEqual(parseClassification('{"onCase":true,"confidence":1,"reason":"On case","extra":[1,2]}'), { onCase: true, confidence: 1, reason: 'On case' });
    assert.strictEqual(parseClassification(`{"onCase":true,"confidence":0.5,"reason":"${'r'.repeat(300)}"}`).reason.length, 200);
  });

  it('rejects anything else as malformed', () => {
    for (const bad of [
      `Sure! ${DETOUR}`,
      '{"confidence":0.9,"reason":"x"}',
      '{"onCase":false,"confidence":"0.9","reason":"x"}',
      '{"onCase":false,"confidence":1.5,"reason":"x"}',
      '{"onCase":false,"confidence":0.9,"reason":"  "}',
      '[{"onCase":false,"confidence":0.9,"reason":"x"}]',
      'onCase: no',
      '{"onCase": false, "confidence": 0.9',
      ''
    ]) {
      assert.strictEqual(parseClassification(bad), null, bad);
    }
  });
});

describe('DetourClassifier', () => {
  it('sends the frozen prompt and the case JSON on the classify role, and flags a detour at 0.7', async () => {
    const h = host(() => '{"onCase":false,"confidence":0.7,"reason":"A different project"}');
    const { classifier, info, turn } = await activeCase(h);
    const r = await classifier.classify(info.id, { source: 'owner-message', text: 'Also fix the phone agent status polling', turn });
    assert.deepStrictEqual(r, { onCase: false, confidence: 0.7, reason: 'A different project', detour: true, failed: null });
    const [call] = h.calls;
    assert.strictEqual(call.tier, 'fast');
    assert.strictEqual(call.opts.systemPrompt, CLASSIFY_SYSTEM);
    assert.deepStrictEqual([call.opts.temperature, call.opts.maxTokens], [0, 200]);
    assert.ok(call.opts.abortSignal instanceof AbortSignal);
    // Controller ruling M7: a classify call must go through
    // sendMessageWithTools with a non-empty confined tool list, mirroring
    // orient — inference-router.js only reports llmMetrics (which is what
    // gets a call charged to the case) on that path.
    assert.ok(Array.isArray(call.opts.tools) && call.opts.tools.length > 0, 'classify call must carry a non-empty tools array');
    // Final review M3: a fixed list, not the wake-up list or the case tools,
    // so a wider list cannot draw more tool-call (malformed) replies.
    assert.deepStrictEqual(call.opts.tools.map((t) => t.name), ['Read']);
    assert.deepStrictEqual(JSON.parse(call.messages[0].text), {
      case: { title: 'Rear door quotes', type: 'outreach', objective: 'Three written quotes for the rear door', successCriteria: ['Three written quotes'], hardConstraints: ['Under 2,000 dollars'] },
      work: { source: 'owner-message', serves: null, text: 'Also fix the phone agent status polling' }
    });
    const [row] = new DetourLog(info.dir).rows();
    assert.deepStrictEqual([row.type, row.turnId, row.source, row.onCase, row.confidence, row.failed], ['classification', 'turn-41', 'owner-message', false, 0.7, null]);
  });

  it('treats 0.69 as on-case', async () => {
    const h = host(() => '{"onCase":false,"confidence":0.69,"reason":"Maybe a different project"}');
    const { classifier, info, turn } = await activeCase(h);
    const r = await classifier.classify(info.id, { source: 'plan', text: 'Patch the phone agent', turn });
    assert.deepStrictEqual([r.onCase, r.detour], [false, false]);
  });

  it('skips drafts, short owner messages and the setting, without a call', async () => {
    const h = host(() => DETOUR);
    const { rt, classifier, info, turn } = await activeCase(h);
    assert.strictEqual((await classifier.classify(info.id, { source: 'owner-message', text: 'ok thanks', turn })).skipped, 'short');
    const draft = await rt.createCase({ title: 'Garage sale', objective: 'Clear the garage' });
    assert.strictEqual((await classifier.classify(draft.id, { source: 'owner-message', text: 'Fix the phone agent code now please' })).skipped, 'draft');
    const off = new DetourClassifier({ runtime: rt, getSettings: () => ({ detours: { ...rt.settings().detours, classifyOwnerMessages: false } }) });
    assert.strictEqual((await off.classify(info.id, { source: 'owner-message', text: 'Fix the phone agent code now please', turn })).skipped, 'disabled');
    assert.strictEqual(h.calls.length, 0);
    const plan = await classifier.classify(info.id, { source: 'plan', text: 'ok', turn });
    assert.strictEqual(plan.detour, true, 'plans are classified whatever their length');
  });

  it('caches the same input for ten minutes', async () => {
    const h = host(() => DETOUR);
    const { rt, info, turn } = await activeCase(h);
    let now = new Date('2026-09-23T15:00:00Z');
    const classifier = new DetourClassifier({ runtime: rt, now: () => now });
    const args = { source: 'executor', serves: 'fix dropped-call status', text: 'Patch status polling in the phone agent', turn };
    await classifier.classify(info.id, args);
    const again = await classifier.classify(info.id, args);
    assert.strictEqual(again.cached, true);
    assert.strictEqual(h.calls.length, 1);
    await classifier.classify(info.id, { ...args, text: 'Patch the webhook retry in the phone agent' });
    assert.strictEqual(h.calls.length, 2);
    now = new Date('2026-09-23T15:11:00Z');
    await classifier.classify(info.id, args);
    assert.strictEqual(h.calls.length, 3);
  });

  it('times out through its AbortController and fails open with one journal line per turn', async () => {
    const h = host((messages, opts) => new Promise((resolve, reject) => {
      opts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const { classifier, info, turn } = await activeCase(h, { detours: { classifyTimeoutMs: 30 } });
    const r = await classifier.classify(info.id, { source: 'owner-message', text: 'Fix the phone agent status polling', turn });
    assert.deepStrictEqual(r, { onCase: true, confidence: 0, reason: '', detour: false, failed: 'timeout' });
    assert.strictEqual(h.calls[0].opts.abortSignal.aborted, true);
    await classifier.classify(info.id, { source: 'plan', text: 'Rewrite the phone agent webhook', turn });
    const lines = journalLines(info.dir);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(info.dir, 'journal', lines[0]), 'utf8'), 'Detour classifier failed (timeout) on owner-message; treated as on-case.\n');
    assert.deepStrictEqual(new DetourLog(info.dir).rows().map((r2) => r2.failed), ['timeout', 'timeout']);
  });

  it('malformed replies ("onCase: no", a truncated object, an array) are on-case with one journal line', async () => {
    const replies = ['onCase: no', '{"onCase": false, "confidence": 0.9', '[{"onCase":false,"confidence":0.9,"reason":"x"}]'];
    const h = host((m, o, n) => replies[n - 1]);
    const { classifier, info, turn } = await activeCase(h);
    for (const text of ['Fix the phone agent code', 'Rewrite the webhook handler', 'Move the phone agent to a new host']) {
      const r = await classifier.classify(info.id, { source: 'owner-message', text, turn });
      assert.deepStrictEqual([r.onCase, r.detour, r.failed], [true, false, 'malformed']);
    }
    assert.strictEqual(journalLines(info.dir).length, 1);
  });

  it('a tool-call reply (the model reached for a tool instead of answering) is malformed, same as orient', async () => {
    const h = host(() => ({ type: 'tool_use', toolCalls: [{ toolName: 'Read', toolUseId: 't1', parameters: { path: 'x' } }] }));
    const { classifier, info, turn } = await activeCase(h);
    const r = await classifier.classify(info.id, { source: 'plan', text: 'Patch the phone agent', turn });
    assert.deepStrictEqual([r.onCase, r.detour, r.failed], [true, false, 'malformed']);
  });

  it('skips without a row when the host has no inference router', async () => {
    const rt = new CaseRuntime({ root: tmp() });
    const info = await rt.createCase({ title: 'Rear door quotes', objective: 'Three written quotes' });
    const r = await new DetourClassifier({ runtime: rt }).classify(info.id, { source: 'plan', text: 'Patch the phone agent' });
    assert.deepStrictEqual([r.onCase, r.detour, r.failed, r.skipped], [true, false, null, 'no-router']);
    assert.deepStrictEqual(new DetourLog(info.dir).rows(), []);
  });

  it('reports an error and a missing provider token without a detour', async () => {
    const failing = host(() => { throw new Error('provider down'); });
    const a = await activeCase(failing);
    assert.strictEqual((await a.classifier.classify(a.info.id, { source: 'plan', text: 'Patch it', turn: a.turn })).failed, 'error');
    const noToken = host(() => DETOUR, { token: false });
    const b = await activeCase(noToken);
    assert.strictEqual((await b.classifier.classify(b.info.id, { source: 'plan', text: 'Patch it', turn: b.turn })).failed, 'no-role');
    assert.strictEqual(noToken.calls.length, 0);
  });

  it('charges the call to the case through usageHook when the reply reports metrics', async () => {
    const h = host(() => ({ content: DETOUR, llmMetrics: { provider: 'openai', model: 'small', inputTokens: 300, outputTokens: 40, totalTokens: 340, costUsd: 0.25 } }));
    const { rt, classifier, info, turn } = await activeCase(h);
    const before = rt.budget(info.id).status().usd.spent;
    const r = await classifier.classify(info.id, { source: 'plan', text: 'Patch the phone agent', turn });
    assert.strictEqual(r.detour, true);
    assert.strictEqual(h.recorded.length, 1);
    assert.strictEqual(rt.budget(info.id).status().usd.spent, before + 0.25);
  });
});
