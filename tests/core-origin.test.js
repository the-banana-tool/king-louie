// tests/core-origin.test.js
// Fleet stage 7 §3.5 / program §4.21: a local-desktop run (marked event or a
// marked parent requester) keeps the on-screen dialog, always-approve and
// `allow` rules in every remoteApprovals mode; everything else is remote.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCore } = require('../src/core');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { createAesGcmCipher } = require('../src/platform/cipher');
const { createHeadlessPrompter } = require('../src/platform/prompter');
const { Tool } = require('../src/tools/tool-schema');
const { toolRegistry } = require('../src/tools');
const {
  markLocalDesktopEvent, isLocalDesktopEvent, localDesktopDeviceId, markLocalRequester, isLocalRequester
} = require('../src/core/origin');

const PROBE = 'KlTestOriginProbe';
let probeRuns = 0;
const cores = [];
const dirs = [];

before(() => {
  toolRegistry.register(new Tool({
    name: PROBE,
    description: 'Test-only tool that requires approval.',
    parameters: { type: 'object', properties: {} },
    requiresApproval: true,
    execute: async () => { probeRuns += 1; return { ok: true }; }
  }));
});

after(async () => {
  for (const core of cores) await core.shutdown().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

async function buildCore(remoteApprovals) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-origin-'));
  dirs.push(dataDir);
  const core = createCore({
    paths: { dataDir },
    store: new JsonFileStore({ dir: dataDir, name: 'chat-data', defaults: { chats: [], activeChatId: null, apiTokens: {}, apiStatus: {}, toolApprovals: { alwaysApproveTools: {} } } }),
    vaultStore: new JsonFileStore({ dir: dataDir, name: 'config' }),
    cipher: createAesGcmCipher(crypto.randomBytes(32)),
    prompter: createHeadlessPrompter(),
    builtinSkillsDir: path.join(__dirname, '..', 'skills'),
    features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
    remoteApprovals
  });
  cores.push(core);
  await core.start();
  return core;
}

function fakeSender() {
  const sent = [];
  return { sent, send: (channel, payload) => sent.push([channel, payload]), isDestroyed: () => false };
}

// Files (relative to the repo root, forward-slash separated) that call the
// given mark function, found by walking src/ and bin/ and checking main.js.
function findMarkCallers(callPattern) {
  const root = path.join(__dirname, '..');
  const callers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && callPattern.test(fs.readFileSync(full, 'utf8'))) {
        callers.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  };
  walk(path.join(root, 'src'));
  walk(path.join(root, 'bin'));
  if (callPattern.test(fs.readFileSync(path.join(root, 'main.js'), 'utf8'))) callers.push('main.js');
  return callers;
}

// Resolves with the approvalRequired payload once the sender gets one; cancel() stops polling.
function watchForPrompt(sender) {
  let timer = null;
  let stopped = false;
  const promise = new Promise((resolve) => {
    if (!sender) return;
    const tick = () => {
      if (stopped) return;
      const hit = sender.sent.find(([channel]) => channel === 'tool:approvalRequired');
      if (hit) resolve({ prompt: hit[1] });
      else timer = setTimeout(tick, 5);
    };
    tick();
  });
  return { promise, cancel: () => { stopped = true; clearTimeout(timer); } };
}

async function runProbe(core, { event = null, requester = null, options = {}, answer = true } = {}) {
  const executor = await core.context.createToolExecutorWithApprovals(event, null, requester, options);
  const before = probeRuns;
  const pending = executor.execute(PROBE, {});
  const watch = watchForPrompt(event && event.sender);
  const first = await Promise.race([pending.then((done) => ({ done })), watch.promise]);
  watch.cancel();
  let prompted = false;
  if (first.prompt) {
    prompted = true;
    core.pendingApprovalResolvers.get(first.prompt.approvalId).resolve(answer);
  }
  const result = first.done || await pending;
  return { result, prompted, ran: probeRuns > before };
}

describe('origin marks', () => {
  it('marks an event object, not a copy of its fields', () => {
    const event = markLocalDesktopEvent({ sender: fakeSender() }, { deviceId: 'kld-abcdefghijklmnop' });
    assert.strictEqual(isLocalDesktopEvent(event), true);
    assert.strictEqual(localDesktopDeviceId(event), 'kld-abcdefghijklmnop');
    assert.strictEqual(isLocalDesktopEvent({ ...event }), false);
    assert.strictEqual(localDesktopDeviceId({ ...event }), null);
    assert.strictEqual(isLocalDesktopEvent(null), false);
    assert.strictEqual(localDesktopDeviceId(markLocalDesktopEvent({})), null, 'the Electron host marks without a device id');
  });

  it('marks requester functions', () => {
    const fn = async () => true;
    assert.strictEqual(isLocalRequester(fn), false);
    assert.strictEqual(markLocalRequester(fn), fn);
    assert.strictEqual(isLocalRequester(fn), true);
    assert.strictEqual(isLocalRequester(async () => true), false);
    assert.strictEqual(isLocalRequester('not a function'), false);
  });

  it('markLocalDesktopEvent is called only by the standalone wrapper and the bridge dispatcher', () => {
    const allowed = new Set(['src/core/origin.js', 'src/ipc/standalone-host.js', 'src/desktop-bridge/bridge-dispatcher.js']);
    const callers = findMarkCallers(/markLocalDesktopEvent\(/);
    assert.deepStrictEqual(callers.filter((f) => !allowed.has(f)), []);
  });

  it('markLocalRequester is called only by origin.js, the ToolExecutor, the standalone wrapper and the bridge dispatcher', () => {
    const allowed = new Set([
      'src/core/origin.js',
      'src/execution/tool-executor.js',
      'src/ipc/standalone-host.js',
      'src/desktop-bridge/bridge-dispatcher.js'
    ]);
    const callers = findMarkCallers(/markLocalRequester\(/);
    assert.deepStrictEqual(callers.filter((f) => !allowed.has(f)), []);
  });
});

for (const mode of ['deny', 'allow']) {
  describe(`createToolExecutorWithApprovals, remoteApprovals '${mode}'`, () => {
    it('a marked event keeps the always-approve list', async () => {
      const core = await buildCore(mode);
      core.context.setToolAlwaysApprove(PROBE, true);
      const out = await runProbe(core, { event: markLocalDesktopEvent({ sender: fakeSender() }) });
      assert.strictEqual(out.prompted, false);
      assert.strictEqual(out.ran, true);
    });

    it('a marked event keeps `allow` rules', async () => {
      const core = await buildCore(mode);
      core.context.addPermissionRule({ tool: PROBE, pattern: '*', action: 'allow' });
      const out = await runProbe(core, { event: markLocalDesktopEvent({ sender: fakeSender() }) });
      assert.strictEqual(out.prompted, false);
      assert.strictEqual(out.ran, true);
    });

    it('a marked event without a grant gets approvalRequired on its sender', async () => {
      const core = await buildCore(mode);
      const out = await runProbe(core, { event: markLocalDesktopEvent({ sender: fakeSender() }), answer: true });
      assert.strictEqual(out.prompted, true);
      assert.strictEqual(out.ran, true);
    });

    it('executorOptions.denyAutoApproval demotes even a marked run', async () => {
      const core = await buildCore(mode);
      core.context.setToolAlwaysApprove(PROBE, true);
      const out = await runProbe(core, {
        event: markLocalDesktopEvent({ sender: fakeSender() }),
        options: { denyAutoApproval: true },
        answer: false
      });
      assert.strictEqual(out.prompted, true, 'the always-approve grant must not apply');
      assert.strictEqual(out.ran, false);
    });

    it('an unmarked copy of a marked event is treated as today', async () => {
      const core = await buildCore(mode);
      core.context.setToolAlwaysApprove(PROBE, true);
      const marked = markLocalDesktopEvent({ sender: fakeSender() });
      const out = await runProbe(core, { event: { sender: marked.sender }, answer: false });
      if (mode === 'deny') {
        assert.strictEqual(out.prompted, true, "'deny' demotes an unmarked run's always-approve grant");
        assert.strictEqual(out.ran, false);
      } else {
        assert.strictEqual(out.prompted, false, "'allow' keeps today's behaviour");
        assert.strictEqual(out.ran, true);
      }
    });

    it('a requester-only executor is local only when the requester is marked', async () => {
      const core = await buildCore(mode);
      let calls = 0;
      const plain = async () => { calls += 1; return true; };
      const plainOut = await runProbe(core, { requester: plain });
      if (mode === 'deny') {
        assert.strictEqual(calls, 0, "'deny' ignores an unmarked requester");
        assert.strictEqual(plainOut.ran, false);
      } else {
        assert.strictEqual(calls, 1);
        assert.strictEqual(plainOut.ran, true);
      }
      let parentCalls = 0;
      const parent = markLocalRequester(async () => { parentCalls += 1; return true; });
      const childOut = await runProbe(core, { requester: parent });
      assert.strictEqual(parentCalls, 1, "a child of a local run asks through the parent's dialog");
      assert.strictEqual(childOut.ran, true);
    });
  });
}

describe("createToolExecutorWithApprovals, remoteApprovals 'deny', a requester-only local run", () => {
  it('a null event with a marked requester keeps the always-approve list', async () => {
    const core = await buildCore('deny');
    core.context.setToolAlwaysApprove(PROBE, true);
    let calls = 0;
    const requester = markLocalRequester(async () => { calls += 1; return true; });
    const out = await runProbe(core, { requester });
    assert.strictEqual(calls, 0, 'auto-approved before the requester is ever asked');
    assert.strictEqual(out.ran, true);
  });

  it('a null event with a marked requester keeps `allow` rules', async () => {
    const core = await buildCore('deny');
    core.context.addPermissionRule({ tool: PROBE, pattern: '*', action: 'allow' });
    let calls = 0;
    const requester = markLocalRequester(async () => { calls += 1; return true; });
    const out = await runProbe(core, { requester });
    assert.strictEqual(calls, 0, 'auto-approved before the requester is ever asked');
    assert.strictEqual(out.ran, true);
  });

  it('the same run with an unmarked requester loses the always-approve grant', async () => {
    const core = await buildCore('deny');
    core.context.setToolAlwaysApprove(PROBE, true);
    let calls = 0;
    const requester = async () => { calls += 1; return true; };
    const out = await runProbe(core, { requester });
    assert.strictEqual(calls, 0, "'deny' ignores an unmarked requester entirely");
    assert.strictEqual(out.ran, false);
  });

  it('the same run with an unmarked requester loses `allow` rules', async () => {
    const core = await buildCore('deny');
    core.context.addPermissionRule({ tool: PROBE, pattern: '*', action: 'allow' });
    let calls = 0;
    const requester = async () => { calls += 1; return true; };
    const out = await runProbe(core, { requester });
    assert.strictEqual(calls, 0, "'deny' ignores an unmarked requester entirely");
    assert.strictEqual(out.ran, false);
  });

  it('a marked requester that answers false results in a refusal', async () => {
    const core = await buildCore('deny');
    let calls = 0;
    const requester = markLocalRequester(async () => { calls += 1; return false; });
    const out = await runProbe(core, { requester });
    assert.strictEqual(calls, 1, 'the marked requester is asked directly');
    assert.strictEqual(out.ran, false);
    assert.strictEqual(out.result.success, false);
    assert.strictEqual(out.result.deniedBy, 'user');
  });
});
