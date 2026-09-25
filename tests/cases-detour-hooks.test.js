// tests/cases-detour-hooks.test.js
// The two detour hooks (cases stage 5 spec §3.6) through the real runtime
// and C2's chat send path, the case-type refresh and trigger, and
// CaseRuntime.detourGate (spec §3.5).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerChatHandlers } = require('../src/ipc/chat-handlers');
const IPC = require('../src/ipc/constants');
const { initializeTools, toolRegistry } = require('../src/tools');
const { CaseRuntime } = require('../src/cases');
const { DetourLog } = require('../src/cases/detours/log');

initializeTools();

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-hooks-')); dirs.push(d); return d; };

const DETOUR = '{"onCase":false,"confidence":0.9,"reason":"Fixing the phone agent\'s code does not collect quotes."}';

function makeRuntime({ reply = () => DETOUR, cases = {}, exec } = {}) {
  const calls = [];
  const rt = new CaseRuntime({
    root: tmp(),
    getSettings: () => ({ cases }),
    host: {
      inferenceRouter: { async routeWithFallback(tier, messages, opts) { calls.push({ tier, messages, opts }); return reply(messages, opts); } },
      interactive: () => true,
      ...(exec ? { exec } : {})
    }
  });
  return { rt, calls };
}

async function activeCase(rt, title, objective, type = 'general', repo = null) {
  const info = await rt.createCase({ title, objective, type, force: true });
  rt.brief(info.id).update('why', 'The owner asked for it', { provenance: 'user' });
  rt.brief(info.id).append('successCriteria', objective, { provenance: 'model' });
  if (repo) rt.brief(info.id).update('repo', repo, { provenance: 'user' });
  rt.completeGating(info.id);
  return rt.getCase(info.id);
}

// C2's chat send path with the real runtime; the agent loop only records.
function chatHarness(rt, caseId, { hookResult = null } = {}) {
  const seen = { prompts: [] };
  const chat = { id: 'chat-1', title: 'Case chat', caseId, messages: [] };
  class FakeLoop {
    async run(messages, tools, options) {
      seen.prompts.push(options.systemPrompt);
      return { content: 'Noted.', llm: { calls: [], totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 } } };
    }
  }
  const overrides = {
    getChats: () => [chat],
    setChats: () => {},
    appendMessageToChat: (_id, sender, text) => { chat.messages.push({ id: `m${chat.messages.length}`, sender, text, timestamp: new Date().toISOString() }); return chat; },
    runHookEvent: async () => hookResult || {},
    resolveInference: async () => ({ providerType: 'openai', provider: { sendMessageWithTools: async () => ({}) }, model: 'test-model', tier: 'standard', timeoutMs: 1000 }),
    getConversationCompactor: () => null,
    getContextAssembler: () => null,
    getRuntimeEnvironment: async () => ({ platform: process.platform }),
    buildMemoryContextSection: async () => '',
    buildRuntimeSystemPrompt: () => 'BASE-PROMPT',
    createToolExecutorWithApprovals: async () => ({ on() {}, execute: async () => ({ ok: true }) }),
    toolRegistry,
    withNotificationTiming: async (_label, fn) => fn(),
    AgentLoop: FakeLoop,
    getSettings: () => ({}),
    getVoiceSettings: () => ({ enabled: false }),
    getCaseRuntime: () => rt,
    createId: () => `id-${Math.random().toString(16).slice(2)}`
  };
  const context = new Proxy(overrides, { get: (target, key) => (key in target ? target[key] : () => null) });
  const handlers = new Map();
  registerChatHandlers({ handle: (channel, fn) => handlers.set(channel, fn), on: () => {} }, context);
  const event = { sender: { send() {}, isDestroyed: () => false } };
  const send = (message) => handlers.get(IPC.CHAT_SEND_MESSAGE)(event, { chatId: 'chat-1', message, agentMode: true });
  return { send, seen };
}

describe('owner-message phase', () => {
  it('does not run when UserPromptSubmit blocks the message', async () => {
    const { rt, calls } = makeRuntime();
    const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
    const { send } = chatHarness(rt, door.id, { hookResult: { action: 'deny', message: 'not now' } });
    const result = await send('Please fix the phone agent code that drops calls');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(calls.length, 0, 'no classify call');
    assert.deepStrictEqual(new DetourLog(door.dir).rows(), []);
    assert.deepStrictEqual(rt.questions(door.id).open(), []);
  });

  it('mixed message: one proposal, a note that says continue, and the status unchanged', async () => {
    // The mock judges the whole message: it is a detour only because of its
    // off-case part, which the reason quotes (review ruling M12).
    const ON_CASE = '{"onCase":true,"confidence":0.9,"reason":"Collecting a quote serves the objective."}';
    const { rt, calls } = makeRuntime({ reply: (messages) => (JSON.stringify(messages).includes('fix the phone agent code') ? DETOUR : ON_CASE) });
    const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
    const phone = await activeCase(rt, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
    const { send, seen } = chatHarness(rt, door.id);
    const message = 'Get the third quote from the glazier, and also fix the phone agent code that drops calls';
    const result = await send(message);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(calls.length, 1);
    const proposals = new DetourLog(door.dir).rows().filter((r) => r.type === 'proposal');
    assert.strictEqual(proposals.length, 1);
    assert.strictEqual(proposals[0].source, 'owner-message');
    assert.strictEqual(proposals[0].summary, message);
    const q = rt.questions(door.id).get(proposals[0].questionId);
    assert.strictEqual(q.payload.targets['attach-1'], phone.id);
    const prompt = seen.prompts[0];
    assert.ok(prompt.includes(`Detour check: the owner's message asks for work outside this case's objective (Fixing the phone agent's code does not collect quotes). Do that part in this case only if the owner insists. Routing proposal ${q.id} (attach to "Phone agent maintenance" (active) / new case / drop) is waiting. Say so in one line, then continue with the on-case part.`));
    assert.strictEqual(rt.getCase(door.id).status, 'active');
    await send(message);
    assert.strictEqual(new DetourLog(door.dir).rows().filter((r) => r.type === 'proposal').length, 1, 'the same message proposes once');
  });

  it('adds the check-before-write note on a software-repo case', async () => {
    const snapshot = { stdout: '[{"number":12,"title":"Fix status polling","headRefName":"fix/status-poll","url":"https://github.com/example/phone-agent/pull/12","isDraft":false}]', stderr: '', code: 0 };
    const exec = async (file) => (file === 'gh' ? snapshot : { stdout: '', stderr: '', code: 1 });
    const { rt } = makeRuntime({ reply: () => '{"onCase":true,"confidence":0.95,"reason":"Fixing the agent is the objective"}', exec });
    const repo = await activeCase(rt, 'Phone agent maintenance', 'Keep the phone agent healthy', 'software-repo', 'https://github.com/example/phone-agent.git');
    const turn = await rt.beginTurn(repo.id, { turnId: 'turn-1', source: 'owner', ownerMessage: 'Please fix the status polling bug' });
    const out = await rt.runOwnerMessageHooks(turn);
    assert.deepStrictEqual(out.notes, ['Before writing code: this may already be in flight — PR #12 "Fix status polling" (fix/status-poll). Check them first and say which you are building on.']);
    await rt.endTurn(turn, { summary: 'x' });
  });
});

describe('turn-start phase', () => {
  it('reconciles an answered routing question before the orientation is built', async () => {
    const { rt } = makeRuntime();
    const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
    await activeCase(rt, 'Phone agent maintenance', 'Keep the phone agent answering and reporting call status');
    const p = await rt.detours.propose(door.id, { summary: 'Fix the phone agent status polling', reason: 'Different project' });
    assert.match(rt.orientation(door.id), /d-0001 proposed: Fix the phone agent status polling — routing question q-0001 is waiting for the owner/);
    await rt.answerQuestion(door.id, p.questionId, { channel: 'in-app', optionId: 'attach-1' });
    const turn = await rt.beginTurn(door.id, { turnId: 'turn-2', source: 'wakeup' });
    assert.match(turn.orientation, /## Detours and related cases\n- related: "Phone agent maintenance" \(active\) — Fix the phone agent status polling/);
    assert.doesNotMatch(turn.orientation, /d-0001 proposed/);
    await rt.endTurn(turn, { summary: 'x' });
  });

  it('refreshes the software-repo snapshot and raises a blocking case-type trigger against the baseline', async () => {
    let head = 'aaaaaaa1111111';
    const exec = async (file, args) => {
      const cmd = args.slice(5).join(' ');
      if (file === 'gh') return { stdout: '[]', stderr: '', code: 0 };
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: 'main\n', stderr: '', code: 0 };
      if (cmd === 'rev-parse HEAD') return { stdout: `${head}\n`, stderr: '', code: 0 };
      if (cmd.startsWith('remote')) return { stdout: 'https://github.com/example/phone-agent.git\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const { rt } = makeRuntime({ exec });
    const repoDir = tmp();
    const c = await activeCase(rt, 'Phone agent maintenance', 'Keep the phone agent healthy', 'software-repo', repoDir);
    let turn = await rt.beginTurn(c.id, { turnId: 'turn-1', source: 'wakeup' });
    assert.deepStrictEqual(turn.triggers.filter((t) => t.kind === 'case-type-change'), [], 'no baseline yet');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'case-type.json'), 'utf8')).state.head, 'aaaaaaa1111111');
    await rt.endTurn(turn, { summary: 'first look' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'triggers.json'), 'utf8')).caseTypeMaterial, { head: 'aaaaaaa1111111', branch: 'main', openPrs: [] });
    head = 'bbbbbbb2222222';
    turn = await rt.beginTurn(c.id, { turnId: 'turn-2', source: 'wakeup' });
    const [t] = turn.triggers.filter((x) => x.kind === 'case-type-change');
    assert.deepStrictEqual([t.detail, t.blocking], ['head changed: aaaaaaa1111111 → bbbbbbb2222222', true]);
    assert.match(t.key, /^case-type:head:[0-9a-f]{8}$/);
    assert.strictEqual(turn.reorientPending, true);
    assert.match(turn.orientation, /## Re-orientation required\n- head changed: aaaaaaa1111111 → bbbbbbb2222222/);
    await rt.endTurn(turn, { summary: 'second look' });
  });

  it('uses the stale snapshot when git and gh overrun the budget, and writes the late result next turn', async () => {
    let gate = null;
    let release;
    let branch = 'main';
    const exec = async (file, args) => {
      if (gate) await gate;
      if (file === 'gh') return { stdout: '[]', stderr: '', code: 0 };
      const cmd = args.slice(5).join(' ');
      if (cmd === 'rev-parse --abbrev-ref HEAD') return { stdout: `${branch}\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const { rt } = makeRuntime({ exec, cases: { softwareRepo: { refreshBudgetMs: 30 } } });
    const c = await activeCase(rt, 'Phone agent maintenance', 'Keep the phone agent healthy', 'software-repo', tmp());
    let turn = await rt.beginTurn(c.id, { turnId: 'turn-1', source: 'wakeup' });
    await rt.endTurn(turn, { summary: 'first' });
    const fetched = JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'case-type.json'), 'utf8')).fetchedAt;
    branch = 'fix/status-poll';
    gate = new Promise((resolve) => { release = resolve; });
    turn = await rt.beginTurn(c.id, { turnId: 'turn-2', source: 'wakeup' });
    assert.ok(turn.orientation.includes(`(stale, fetched ${fetched})`));
    await rt.endTurn(turn, { summary: 'second' });
    gate = null;
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(rt.caseTypeSnapshot(c.id).state.branch, 'fix/status-poll', 'the late result lands in memory');
    turn = await rt.beginTurn(c.id, { turnId: 'turn-3', source: 'wakeup' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(c.dir, '.kl', 'case-type.json'), 'utf8'));
    assert.deepStrictEqual([onDisk.stale, onDisk.state.branch], [false, 'fix/status-poll']);
    await rt.endTurn(turn, { summary: 'third' });
  });
});

describe('CaseRuntime.detourGate', () => {
  it('refuses a detour with the Detour instruction, passes unsure work with a note, and fails open', async () => {
    let reply = DETOUR;
    const { rt } = makeRuntime({ reply: () => reply });
    const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
    const turn = await rt.beginTurn(door.id, { turnId: 'turn-1', source: 'owner', ownerMessage: 'go' });
    const refused = await rt.detourGate(door.id, { source: 'executor', serves: 'fix dropped-call status', text: 'Patch status polling in the phone agent', turnId: 'turn-1' });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.error, 'This work looks like a detour from the case objective ("Three written quotes for the rear door"): Fixing the phone agent\'s code does not collect quotes. Do not do it in this case. Call Detour with action "propose" (blocks: true if this case cannot proceed without it), then continue with on-case work.');
    assert.strictEqual(refused.classification.detour, true);
    reply = '{"onCase":false,"confidence":0.5,"reason":"Might be for another project"}';
    assert.deepStrictEqual(await rt.detourGate(door.id, { source: 'plan', text: 'Call three glaziers and the phone vendor', turnId: 'turn-1' }), { ok: true, note: 'The classifier was unsure this serves the objective: Might be for another project.' });
    reply = 'not json';
    assert.deepStrictEqual(await rt.detourGate(door.id, { source: 'plan', text: 'Call the glazier back', turnId: 'turn-1' }), { ok: true });
    await assert.rejects(rt.detourGate(door.id, { source: 'owner-message', text: 'x' }), /plan or executor/);
    await rt.endTurn(turn, { summary: 'x' });
  });
});

// Controller rulings (Task 7 router, Task 8): router error results and
// thrown errors inside the hooks or the gate log and never abort a turn.
describe('failures never abort the turn', () => {
  it('turn start continues when reconcile returns an error and releaseHeld throws', async () => {
    const { rt } = makeRuntime();
    const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
    const real = rt.detours;
    rt._detours = Object.assign(Object.create(real), {
      reconcile: async () => ({ applied: [], error: 'reconcile broke' }),
      releaseHeld: () => { throw new Error('release broke'); }
    });
    const turn = await rt.beginTurn(door.id, { turnId: 'turn-1', source: 'wakeup' });
    assert.doesNotMatch(turn.orientation, /hook detours failed/);
    await rt.endTurn(turn, { summary: 'x' });
  });

  it('owner-message hook: a throwing classifier is on-case, and a failed proposal is a note', async () => {
    const { rt } = makeRuntime();
    const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
    const turn = await rt.beginTurn(door.id, { turnId: 'turn-1', source: 'owner', ownerMessage: 'Please fix the phone agent code that drops calls' });
    rt._classifier = { classify: async () => { throw new Error('classifier broke'); } };
    let out = await rt.runOwnerMessageHooks(turn);
    assert.deepStrictEqual(out.notes, []);
    rt._classifier = { classify: async () => ({ onCase: false, confidence: 0.9, reason: 'Different project.', detour: true, failed: null }) };
    rt._detours = Object.assign(Object.create(rt.detours), { propose: async () => ({ ok: false, error: 'Case "Rear door quotes" is busy with another turn. Try again when it finishes.' }) });
    out = await rt.runOwnerMessageHooks(turn);
    assert.deepStrictEqual(out.notes, ["Detour check: the owner's message asks for work outside this case's objective (Different project), and routing it failed: Case \"Rear door quotes\" is busy with another turn. Try again when it finishes."]);
    await rt.endTurn(turn, { summary: 'x' });
  });

  it('detourGate lets the work through when classification throws', async () => {
    const { rt } = makeRuntime();
    const door = await activeCase(rt, 'Rear door quotes', 'Three written quotes for the rear door', 'outreach');
    rt._classifier = { classify: async () => { throw new Error('classifier broke'); } };
    assert.deepStrictEqual(await rt.detourGate(door.id, { source: 'executor', text: 'Patch status polling', turnId: 'turn-1' }), { ok: true });
    assert.deepStrictEqual(await rt.detourGate('no-such-case', { source: 'plan', text: 'Call the glazier back' }), { ok: true });
  });
});
