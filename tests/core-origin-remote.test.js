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
  }

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
