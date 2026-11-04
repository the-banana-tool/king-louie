// tests/core-origin-remote.test.js
// Remote window plan, R-RW-9: a remote window's event is never local. It keeps
// its device id and the phone's request id, a copy of it has no mark, and the
// approval seam shuts auto-approval for it in every mode.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  markLocalDesktopEvent, isLocalDesktopEvent, localDesktopDeviceId, markLocalRequester,
  markRemoteWindowEvent, isRemoteWindowEvent, remoteWindowDeviceId, remoteWindowApproved
} = require('../src/core/origin');
const { approvalSeam } = require('../src/approvals/executor-options');
const { toolAction } = require('../src/approvals/messages');
const ToolExecutor = require('../src/execution/tool-executor');
const { initializeTools } = require('../src/tools');
const fs = require('fs');
const os = require('os');
const path = require('path');

initializeTools();

const DEVICE = 'kld-abcdefghijklmnop';
const REQUEST = 'req-0001';
const fakePhone = () => ({ ttlMs: 1000, requestApproval: async () => true, isAvailable: () => true });

describe('the remote-window mark', () => {
  it('is not local and keeps the device id and the approval', () => {
    const event = {};
    assert.strictEqual(markRemoteWindowEvent(event, { deviceId: DEVICE, approved: REQUEST }), event);
    assert.strictEqual(isRemoteWindowEvent(event), true);
    assert.strictEqual(isLocalDesktopEvent(event), false);
    assert.strictEqual(localDesktopDeviceId(event), null);
    assert.strictEqual(remoteWindowDeviceId(event), DEVICE);
    assert.strictEqual(remoteWindowApproved(event), REQUEST);
  });

  it('has no approval until the gate gives one', () => {
    const event = markRemoteWindowEvent({}, { deviceId: DEVICE });
    assert.strictEqual(remoteWindowApproved(event), null);
  });

  it('counts only a request id as an approval', () => {
    for (const approved of [true, 1, '', {}]) {
      assert.strictEqual(remoteWindowApproved(markRemoteWindowEvent({}, { deviceId: DEVICE, approved })), null, String(approved));
    }
  });

  it('a copy of the event has no mark', () => {
    const copy = { ...markRemoteWindowEvent({ sender: {} }, { deviceId: DEVICE, approved: REQUEST }) };
    assert.strictEqual(isRemoteWindowEvent(copy), false);
    assert.strictEqual(remoteWindowDeviceId(copy), null);
    assert.strictEqual(remoteWindowApproved(copy), null);
  });

  it('answers nothing for an unmarked event or for what is not an object', () => {
    for (const value of [{}, null, undefined, 'event', 7]) {
      assert.strictEqual(isRemoteWindowEvent(value), false);
      assert.strictEqual(remoteWindowDeviceId(value), null);
      assert.strictEqual(remoteWindowApproved(value), null);
    }
    assert.strictEqual(markRemoteWindowEvent(null, { deviceId: DEVICE }), null);
  });

  it('an event is never both: the second mark deletes the first, either way', () => {
    const remoteThenLocal = markRemoteWindowEvent({}, { deviceId: DEVICE, approved: REQUEST });
    markLocalDesktopEvent(remoteThenLocal, { deviceId: DEVICE });
    assert.strictEqual(isLocalDesktopEvent(remoteThenLocal), true);
    assert.strictEqual(isRemoteWindowEvent(remoteThenLocal), false);
    assert.strictEqual(remoteWindowApproved(remoteThenLocal), null);

    const localThenRemote = markLocalDesktopEvent({}, { deviceId: DEVICE });
    markRemoteWindowEvent(localThenRemote, { deviceId: DEVICE });
    assert.strictEqual(isRemoteWindowEvent(localThenRemote), true);
    assert.strictEqual(isLocalDesktopEvent(localThenRemote), false);
    assert.strictEqual(localDesktopDeviceId(localThenRemote), null);
  });
});

describe('the approval seam for a remote event', () => {
  for (const remoteApprovals of ['allow', 'deny', 'phone']) {
    const seamFor = (extra = {}) => approvalSeam({
      remoteApprovals,
      event: markRemoteWindowEvent({ sender: {} }, { deviceId: DEVICE }),
      executorOptions: { chatId: 'chat-1' },
      phoneApprover: fakePhone(),
      ...extra
    });

    it(`'${remoteApprovals}': not local, auto-approval shut, the origin names remote-window`, () => {
      const seam = seamFor();
      assert.strictEqual(seam.local, false);
      assert.strictEqual(seam.toolExecutorOptions.localOrigin ?? false, false);
      assert.strictEqual(seam.toolExecutorOptions.denyAutoApproval, true);
      assert.deepStrictEqual(seam.origin, { client: 'remote-window', deviceId: DEVICE, session: 'chat-1', job_id: null });
    });

    it(`'${remoteApprovals}': a marked requester does not make it local`, () => {
      const seam = seamFor({ approvalRequester: markLocalRequester(async () => true) });
      assert.strictEqual(seam.local, false);
      assert.strictEqual(seam.toolExecutorOptions.denyAutoApproval, true);
      assert.strictEqual(seam.origin.client, 'remote-window');
    });

    it(`'${remoteApprovals}': a requester handed in does not answer for it`, () => {
      const handed = async () => true;
      const seam = seamFor({ approvalRequester: handed });
      assert.notStrictEqual(seam.toolExecutorOptions.approvalRequester, handed);
    });

    it(`'${remoteApprovals}': the tools that outlive a turn come back unsafe, each named`, () => {
      const { classifyCall } = seamFor().toolExecutorOptions;
      for (const name of ['BackgroundTask', 'TaskStatus', 'message', 'SpawnAgent', 'sessions_spawn', 'sessions_list', 'Cron', 'RemoteDispatch']) {
        const decision = classifyCall(name, {}, {});
        assert.strictEqual(decision && decision.tier, 'unsafe', name);
      }
    });

    it(`'${remoteApprovals}': the same for a child, which carries the remote origin and no event`, () => {
      const seam = approvalSeam({
        remoteApprovals, event: null, approvalRequester: async () => true,
        executorOptions: { origin: { client: 'remote-window', deviceId: DEVICE, session: 'chat-1', job_id: null } },
        phoneApprover: fakePhone()
      });
      assert.strictEqual(seam.local, false);
      assert.strictEqual(seam.toolExecutorOptions.denyAutoApproval, true);
      assert.strictEqual(seam.toolExecutorOptions.classifyCall('SpawnAgent', {}, {}).tier, 'unsafe');
      assert.strictEqual(seam.toolExecutorOptions.remoteWindowTurn, undefined, 'a child has no typed words');
    });

    it(`'${remoteApprovals}': the turn's typed words are open, a closed run's are not`, () => {
      assert.strictEqual(seamFor().toolExecutorOptions.remoteWindowTurn, true);
      const closed = seamFor({ executorOptions: { chatId: 'chat-1', denyAutoApproval: true } });
      assert.strictEqual(closed.toolExecutorOptions.remoteWindowTurn, undefined);
    });
  }

  it('every tool a task turn removes for outliving it counts for a remote turn too, from one list', () => {
    const { taskToolNames } = require('../src/tasks/values');
    const { outlivesRemoteTurn, TASK_REMOVED_TOOLS } = require('../src/approvals/outliving-tools');
    const names = ['Read', 'SpawnAgent', ...TASK_REMOVED_TOOLS, 'sessions_list', 'sessions_history', 'sessions_spawn'];
    const kept = taskToolNames({ list: () => names.map((name) => ({ name })) });
    assert.deepStrictEqual([...kept].sort(), ['Read', 'SpawnAgent'], 'the task list is read from the shared one');
    for (const name of names.filter((n) => !kept.has(n))) assert.strictEqual(outlivesRemoteTurn(name), true, name);
    assert.strictEqual(outlivesRemoteTurn('SpawnAgent'), true);
    for (const name of ['Read', 'Bash', '', null, 'constructor']) assert.strictEqual(outlivesRemoteTurn(name), false, String(name));
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../src/tasks/values.js'), 'utf8'), /'BackgroundTask'/, 'not copied');
  });

  it('a tool that does not outlive the turn keeps the classifier it had, and a denial stays a denial', () => {
    const inner = (name) => (name === 'Refused' || name === 'Cron' ? { tier: 'denied', reason: 'node' } : { tier: 'routine', reason: 'inner' });
    const seam = approvalSeam({
      remoteApprovals: 'deny', event: markRemoteWindowEvent({}, { deviceId: DEVICE }), executorOptions: { chatId: 'chat-1' }
    });
    assert.strictEqual(seam.toolExecutorOptions.classifyCall('Read', {}, {}), null);
    const { remoteClassifier } = require('../src/approvals/executor-options');
    const wrapped = remoteClassifier(inner);
    assert.deepStrictEqual(wrapped('Read', {}, {}), { tier: 'routine', reason: 'inner' });
    assert.strictEqual(wrapped('Refused', {}, {}).tier, 'denied');
    assert.strictEqual(wrapped('Cron', {}, {}).tier, 'denied');
    assert.strictEqual(wrapped('BackgroundTask', {}, {}).tier, 'unsafe');
  });

  it('a phone-mode node policy still classifies a remote run, under the wrap', () => {
    const seam = approvalSeam({
      remoteApprovals: 'phone', event: markRemoteWindowEvent({}, { deviceId: DEVICE }), executorOptions: { chatId: 'chat-1' }, phoneApprover: fakePhone(),
      nodePolicy: { allowed_roots: [], remote_sessions: { always_confirm: [], deny: ['Blocked*'] } }
    });
    assert.strictEqual(seam.toolExecutorOptions.classifyCall('SpawnAgent', {}, {}).tier, 'unsafe');
  });

  for (const remoteApprovals of ['allow', 'deny']) {
    it(`'${remoteApprovals}': the requester answers false at once, so nothing hangs and nothing runs`, async () => {
      const seam = approvalSeam({ remoteApprovals, event: markRemoteWindowEvent({ sender: {} }, { deviceId: DEVICE }), approvalRequester: async () => true, executorOptions: { chatId: 'chat-1' } });
      assert.strictEqual(await seam.toolExecutorOptions.approvalRequester('Bash', {}, {}), false);
      const executor = new ToolExecutor({ workingDirectory: os.tmpdir(), requireApproval: true, useSandbox: false, ...seam.toolExecutorOptions });
      const out = await executor.execute('Bash', { command: 'echo never' });
      assert.strictEqual(out.success, false);
      assert.strictEqual(out.deniedBy, 'user');
    });
  }

  describe('a Bash card with the sandbox off', () => {
    const summaryOf = async (executorOptions, toolName = 'Bash', params = { command: 'npm test' }) => {
      const seen = {};
      const phoneApprover = { ...fakePhone(), requestApproval: async (_tool, _params, metadata) => { Object.assign(seen, metadata); return false; } };
      const seam = approvalSeam({ remoteApprovals: 'phone', event: markRemoteWindowEvent({}, { deviceId: DEVICE }), executorOptions: { chatId: 'chat-1', ...executorOptions }, phoneApprover });
      await seam.toolExecutorOptions.approvalRequester(toolName, params, {});
      return toolAction(toolName, params, null, seen.cardNote).summary;
    };

    it('says so first, where a cut cannot reach it', async () => {
      assert.match(await summaryOf({ useSandbox: false }), /^Sandbox off: Bash/);
      assert.match(await summaryOf({ useSandbox: false }, 'Bash', { command: `npm ${'x'.repeat(400)}` }), /^Sandbox off: Bash/);
    });

    it('says nothing with the sandbox on, or for another tool', async () => {
      assert.doesNotMatch(await summaryOf({ useSandbox: true }), /Sandbox/);
      assert.doesNotMatch(await summaryOf({}), /Sandbox/);
      assert.doesNotMatch(await summaryOf({ useSandbox: false }, 'Write', { file_path: 'a.txt' }), /Sandbox/);
    });

    it('a local run with the sandbox off keeps its card as it was', () => {
      const seam = approvalSeam({ remoteApprovals: 'phone', event: { sender: {} }, executorOptions: { chatId: 'chat-1', useSandbox: false }, phoneApprover: fakePhone() });
      const metadata = {};
      seam.toolExecutorOptions.approvalRequester('Bash', { command: 'npm test' }, metadata);
      assert.strictEqual(metadata.cardNote, undefined);
    });

    it('with no note the summary is what it always was', () => {
      assert.strictEqual(toolAction('Bash', { command: 'npm test' }, null).summary, toolAction('Bash', { command: 'npm test' }, null, null).summary);
      assert.doesNotMatch(toolAction('Bash', { command: 'npm test' }, null).summary, /Sandbox/);
    });

    it('the approver signs the note and compares it live', () => {
      const text = fs.readFileSync(path.join(__dirname, '../src/approvals/phone-approver.js'), 'utf8');
      assert.strictEqual((text.match(/toolAction\(toolName, parameters, meta\.workingDirectory \|\| null, meta\.cardNote\)/g) || []).length, 2);
    });
  });

  it('in phone mode the question goes to the phone, with the origin it shows', async () => {
    const asked = [];
    const phoneApprover = { ...fakePhone(), requestApproval: async (tool, params, metadata) => { asked.push([tool, metadata.origin]); return true; } };
    const seam = approvalSeam({
      remoteApprovals: 'phone',
      event: markRemoteWindowEvent({ sender: {} }, { deviceId: DEVICE }),
      executorOptions: { chatId: 'chat-1' },
      phoneApprover
    });
    assert.strictEqual(await seam.toolExecutorOptions.approvalRequester('KlProbe', {}, {}), true);
    assert.deepStrictEqual(asked, [['KlProbe', { client: 'remote-window', deviceId: DEVICE, session: 'chat-1', job_id: null }]]);
  });

  it('an origin the run already has stands, as for any run', () => {
    const origin = { client: 'task', session: null, job_id: 'job-1' };
    const seam = approvalSeam({
      remoteApprovals: 'deny',
      event: markRemoteWindowEvent({ sender: {} }, { deviceId: DEVICE }),
      executorOptions: { origin }
    });
    assert.strictEqual(seam.origin, origin);
    assert.strictEqual(seam.local, false);
  });

  it('a local event still answers as it did', () => {
    const seam = approvalSeam({ remoteApprovals: 'deny', event: markLocalDesktopEvent({ sender: {} }, { deviceId: DEVICE }), executorOptions: { chatId: 'chat-1' } });
    assert.strictEqual(seam.local, true);
    assert.strictEqual(seam.toolExecutorOptions.denyAutoApproval, false);
    assert.deepStrictEqual(seam.origin, { client: 'desktop', deviceId: DEVICE, session: 'chat-1', job_id: null });
  });

  it('an unmarked event still answers as it did', () => {
    const handed = async () => true;
    const allow = approvalSeam({ remoteApprovals: 'allow', event: { sender: {} }, approvalRequester: handed, executorOptions: { chatId: 'chat-1' } });
    assert.strictEqual(allow.local, false);
    assert.strictEqual(allow.toolExecutorOptions.denyAutoApproval, false);
    assert.strictEqual(allow.toolExecutorOptions.approvalRequester, handed);
    assert.deepStrictEqual(allow.origin, { client: 'king-louie', session: 'chat-1', job_id: null });
  });
});
