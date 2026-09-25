// tests/tool-executor-remote-tier.test.js
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toolRegistry } = require('../src/tools');
const { Tool } = require('../src/tools/tool-schema');
const ToolExecutor = require('../src/execution/tool-executor');
const { mapApprovalResult } = require('../src/execution/tool-executor');
const { classifyToolCall } = require('../src/execution/safety-policy');
const { isLocalRequester } = require('../src/core/origin');

const runs = { routine: 0, bash: 0, file: 0 };
let captured = null;
let realBash = null;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-remote-tier-'));
const root = path.join(base, 'root');
fs.mkdirSync(root);

before(() => {
  realBash = toolRegistry.get('Bash');
  toolRegistry.register(new Tool({
    name: 'KlTierRoutine', description: 'test', requiresApproval: false,
    parameters: { type: 'object', properties: { x: { type: 'string' } } },
    execute: async () => { runs.routine += 1; return { ok: true }; }
  }));
  toolRegistry.register(new Tool({
    name: 'KlTierFile', description: 'test', requiresApproval: false,
    parameters: { type: 'object', properties: { file_path: { type: 'string' }, edits: { type: 'array' } } },
    execute: async () => { runs.file += 1; return { ok: true }; }
  }));
  toolRegistry.register(new Tool({
    name: 'KlTierCapture', description: 'test', requiresApproval: false,
    parameters: { type: 'object', properties: {} },
    execute: async (_p, options) => { captured = options.approvalRequester; return { ok: true }; }
  }));
  // A stand-in for the shell so no real command runs; it gates like Bash.
  toolRegistry.register(new Tool({
    name: 'Bash', description: 'test stand-in', requiresApproval: true,
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    execute: async () => { runs.bash += 1; return { ok: true }; }
  }));
  // requiresApproval: false, so a classification of `unsafe` can only come
  // from the always_confirm pattern match, never from the tool's own flag.
  toolRegistry.register(new Tool({
    name: 'KlTierGitLike', description: 'test', requiresApproval: false,
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    execute: async () => { return { ok: true }; }
  }));
});

after(() => {
  if (realBash) toolRegistry.register(realBash);
  fs.rmSync(base, { recursive: true, force: true });
});

const policy = { allowed_roots: [root], remote_sessions: { always_confirm: ['Bash(git push*)'], deny: ['Bash(rm -rf /*)'] } };
const classifyCall = (t, p, { cwd }) => classifyToolCall(t, p, policy, { cwd });

function executor(extra = {}) {
  return new ToolExecutor({ workingDirectory: root, runtimeEnvironment: {}, useSandbox: false, ...extra });
}

describe('ToolExecutor classifyCall', () => {
  it('denied: refuses with deniedBy policy and emits tierDecision', async () => {
    const decisions = [];
    const ex = executor({ classifyCall, approvalRequester: async () => true });
    ex.on('tierDecision', (d) => decisions.push(d));
    const before = runs.bash;
    const result = await ex.execute('Bash', { command: 'rm -rf /srv' });
    assert.deepEqual(result, { success: false, error: 'Denied by node policy.', deniedBy: 'policy' });
    assert.equal(runs.bash, before);
    assert.deepEqual(decisions.map((d) => [d.toolName, d.tier, d.reason]), [['Bash', 'denied', 'matched_deny_policy']]);
  });

  it('unsafe forces the gate for a tool that would not ask', async () => {
    const asked = [];
    const ex = executor({ classifyCall: () => ({ tier: 'unsafe', reason: 'test' }), approvalRequester: async (t) => { asked.push(t); return false; } });
    const before = runs.routine;
    const result = await ex.execute('KlTierRoutine', { x: 'y' });
    assert.equal(result.deniedBy, 'user');
    assert.deepEqual(asked, ['KlTierRoutine']);
    assert.equal(runs.routine, before);
  });

  it('unsafe beats allow Bash(git *) for always_confirm Bash(git push*)', async () => {
    const rules = [{ tool: 'Bash', pattern: 'git *', action: 'allow', source: 'test' }];
    const asked = [];
    const requester = async (t, p) => { asked.push(p.command); return false; };
    const without = executor({ permissionRules: rules, approvalRequester: requester });
    const before = runs.bash;
    await without.execute('Bash', { command: 'git push origin main' });
    assert.equal(runs.bash, before + 1, 'baseline: the allow rule skips the gate');
    assert.deepEqual(asked, []);
    const withTier = executor({ permissionRules: rules, approvalRequester: requester, classifyCall });
    const result = await withTier.execute('Bash', { command: 'cd repo && git push origin main' });
    assert.equal(result.success, false);
    assert.deepEqual(asked, ['cd repo && git push origin main']);
    assert.equal(runs.bash, before + 1);
  });

  it('relative file_path and edits[].file_path outside the roots are unsafe, resolved against the working directory', async () => {
    const asked = [];
    const ex = executor({ classifyCall, approvalRequester: async (t, p) => { asked.push(p); return false; } });
    const before = runs.file;
    await ex.execute('KlTierFile', { file_path: 'inside.txt' });
    assert.equal(runs.file, before + 1);
    await ex.execute('KlTierFile', { file_path: '../outside.txt' });
    await ex.execute('KlTierFile', { edits: [{ file_path: 'ok.txt' }, { file_path: path.join(base, 'x.txt') }] });
    assert.equal(asked.length, 2);
    assert.equal(runs.file, before + 1);
  });

  it('read tier: emits tierDecision and runs normally, no forced gate', async () => {
    const decisions = [];
    const ex = executor({
      classifyCall: () => ({ tier: 'read', reason: 'read_only_tool' }),
      approvalRequester: async () => { throw new Error('should not be asked for a read-tier call'); }
    });
    ex.on('tierDecision', (d) => decisions.push(d));
    const before = runs.routine;
    const result = await ex.execute('KlTierRoutine', { x: 'y' });
    assert.equal(result.ok, true);
    assert.equal(runs.routine, before + 1);
    assert.deepEqual(decisions.map((d) => [d.tier, d.reason]), [['read', 'read_only_tool']]);
  });

  it('unsafe blocks shouldAutoApprove', async () => {
    const ex = executor({
      classifyCall: () => ({ tier: 'unsafe', reason: 'test' }),
      shouldAutoApprove: async () => true,
      approvalRequester: async () => false
    });
    const before = runs.routine;
    const result = await ex.execute('KlTierRoutine', { x: 'y' });
    assert.equal(result.deniedBy, 'user');
    assert.equal(runs.routine, before);
  });

  it('unsafe blocks options.autoApproveTools', async () => {
    const ex = executor({
      classifyCall: () => ({ tier: 'unsafe', reason: 'test' }),
      approvalRequester: async () => false
    });
    const before = runs.routine;
    const result = await ex.execute('KlTierRoutine', { x: 'y' }, { autoApproveTools: ['KlTierRoutine'] });
    assert.equal(result.deniedBy, 'user');
    assert.equal(runs.routine, before);
  });

  it('unsafe-beats-allow reason is matched_always_confirm (stand-in tool with requiresApproval:false)', async () => {
    const localPolicy = { allowed_roots: [root], remote_sessions: { always_confirm: ['KlTierGitLike(push*)'], deny: [] } };
    const localClassify = (t, p, { cwd }) => classifyToolCall(t, p, localPolicy, { cwd });
    const rules = [{ tool: 'KlTierGitLike', pattern: '*', action: 'allow', source: 'test' }];
    const decisions = [];
    const ex = executor({ permissionRules: rules, classifyCall: localClassify, approvalRequester: async () => false });
    ex.on('tierDecision', (d) => decisions.push(d));
    const result = await ex.execute('KlTierGitLike', { command: 'push origin main' });
    assert.equal(result.success, false);
    assert.deepEqual(decisions.map((d) => [d.tier, d.reason]), [['unsafe', 'matched_always_confirm']]);
  });
});

describe('ToolExecutor classifyCall fails closed', () => {
  const malformed = ['denied', { tier: 'DENIED' }, { reason: 'x' }, ['denied']];
  for (const bad of malformed) {
    it(`malformed classifyCall result ${JSON.stringify(bad)} is denied, never run`, async () => {
      const decisions = [];
      const ex = executor({ classifyCall: () => bad, approvalRequester: async () => true });
      ex.on('tierDecision', (d) => decisions.push(d));
      const before = runs.routine;
      const result = await ex.execute('KlTierRoutine', { x: 'y' });
      assert.deepEqual(result, { success: false, error: 'Denied by node policy.', deniedBy: 'policy' });
      assert.equal(runs.routine, before);
      assert.deepEqual(decisions.map((d) => [d.tier, d.reason]), [['denied', 'invalid_classification']]);
    });
  }

  it('a throwing classifyCall is caught: same policy refusal, postExecute runs, never throws out of execute()', async () => {
    const postExecuteEvents = [];
    const ex = executor({
      classifyCall: () => { throw new Error('classifyCall boom'); },
      approvalRequester: async () => true
    });
    ex.on('postExecute', (e) => postExecuteEvents.push(e));
    const before = runs.routine;
    const result = await ex.execute('KlTierRoutine', { x: 'y' });
    assert.deepEqual(result, { success: false, error: 'Denied by node policy.', deniedBy: 'policy' });
    assert.equal(runs.routine, before);
    assert.equal(postExecuteEvents.length, 1);
    assert.deepEqual(postExecuteEvents[0].result, result);
  });
});

describe('ToolExecutor approval results', () => {
  const confirmHook = { run: async (event) => (event === 'PreToolUse' ? { action: 'confirm', message: 'check this' } : {}) };

  it("hook confirm: 'timeout' and 'unavailable' run nothing", async () => {
    for (const answer of ['timeout', 'unavailable']) {
      const ex = executor({ hookExecutor: confirmHook, approvalRequester: async () => answer });
      const before = runs.routine;
      const result = await ex.execute('KlTierRoutine', { x: 'y' });
      assert.equal(result.success, false, answer);
      assert.equal(result.blockedByHook, true);
      assert.equal(result.deniedBy, answer);
      assert.equal(runs.routine, before, answer);
    }
  });

  it('gate: a truthy value that is not true runs nothing', async () => {
    for (const answer of ['yes', 'timeout-ish', 1, { approved: true }]) {
      const ex = executor({ approvalRequester: async () => answer });
      const before = runs.bash;
      const result = await ex.execute('Bash', { command: 'ls' });
      assert.deepEqual(result, { success: false, error: 'Approval failed: unexpected requester result.', deniedBy: 'requester' });
      assert.equal(runs.bash, before);
    }
  });

  it('withdrawn: no denial penalty; a plain false is recorded', async () => {
    const denials = [];
    const tracker = { check: () => ({ tripped: false }), recordDenial: (t) => denials.push(t), recordGrant: () => {} };
    const controller = new AbortController();
    const ex = executor({ denialTracker: tracker, approvalRequester: async () => { controller.abort(); return false; } });
    const result = await ex.execute('Bash', { command: 'ls' }, { signal: controller.signal });
    assert.deepEqual(result, { success: false, error: 'Approval withdrawn: the call was cancelled.', deniedBy: 'withdrawn' });
    assert.deepEqual(denials, []);
    const plain = executor({ denialTracker: tracker, approvalRequester: async () => false });
    assert.equal((await plain.execute('Bash', { command: 'ls' })).deniedBy, 'user');
    assert.deepEqual(denials, ['Bash']);
  });

  it("'unavailable' reports the requester's refusal, else the default", async () => {
    const ex = executor({ approvalRequester: async (t, p, m) => { m.refusal = { deniedBy: 'audit', error: 'Audit ledger unavailable; nothing ran.' }; return 'unavailable'; } });
    assert.deepEqual(await ex.execute('Bash', { command: 'ls' }), { success: false, error: 'Audit ledger unavailable; nothing ran.', deniedBy: 'audit' });
    const bare = executor({ approvalRequester: async () => 'unavailable' });
    assert.deepEqual(await bare.execute('Bash', { command: 'ls' }), {
      success: false, error: 'Phone approval unavailable: no enrolled device or no relay link on this node. Nothing ran.', deniedBy: 'unavailable'
    });
  });

  it('metadata carries workingDirectory and signal at both call sites', async () => {
    const seen = [];
    const controller = new AbortController();
    const requester = async (t, p, m) => { seen.push({ wd: m.workingDirectory, signal: m.signal }); return true; };
    await executor({ approvalRequester: requester }).execute('Bash', { command: 'ls' }, { workingDirectory: base, signal: controller.signal });
    await executor({ approvalRequester: requester, hookExecutor: confirmHook }).execute('KlTierRoutine', { x: 'y' });
    assert.equal(seen[0].wd, base);
    assert.equal(seen[0].signal, controller.signal);
    assert.equal(seen[1].wd, root);
    assert.equal(seen[1].signal, null);
  });
});

describe('ToolExecutor localOrigin', () => {
  it('marks the requester handed to tools only for a local run', async () => {
    await executor({ localOrigin: true }).execute('KlTierCapture', {});
    assert.equal(isLocalRequester(captured), true);
    await executor({}).execute('KlTierCapture', {});
    assert.equal(isLocalRequester(captured), false);
  });
});

describe('mapApprovalResult', () => {
  it('maps only true to approved', () => {
    assert.deepEqual(mapApprovalResult(true, {}), { approved: true, penalize: false, refusal: null });
    assert.equal(mapApprovalResult(false, {}).penalize, true);
    assert.equal(mapApprovalResult('timeout', {}, { timeoutMs: 315000 }).refusal.error.startsWith('Approval timed out after 315s'), true);
    assert.equal(mapApprovalResult('unavailable', {}).refusal.deniedBy, 'unavailable');
    assert.equal(mapApprovalResult('true', {}).refusal.deniedBy, 'requester');
    assert.equal(mapApprovalResult(undefined, {}).approved, false);
  });
});
