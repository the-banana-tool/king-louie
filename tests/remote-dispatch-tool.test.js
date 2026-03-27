const { describe, it } = require('node:test');
const assert = require('node:assert');

const RemoteDispatchTool = require('../src/tools/builtin/remote-dispatch-tool');

describe('RemoteDispatchTool', () => {
  it('has the correct name and requires approval', () => {
    assert.strictEqual(RemoteDispatchTool.name, 'RemoteDispatch');
    assert.strictEqual(RemoteDispatchTool.requiresApproval, true);
  });

  it('has required parameters defined', () => {
    const params = RemoteDispatchTool.parameters;
    assert.strictEqual(params.type, 'object');
    assert.ok(params.properties.action);
    assert.ok(params.properties.peer);
    assert.ok(params.properties.message);
    assert.ok(params.properties.taskId);
    assert.deepStrictEqual(params.required, ['action']);
  });

  it('validates action enum', () => {
    const enums = RemoteDispatchTool.parameters.properties.action.enum;
    assert.deepStrictEqual(enums, ['peers', 'dispatch', 'status', 'cancel']);
  });

  it('returns error when mesh is not enabled', async () => {
    const result = await RemoteDispatchTool.execute(
      { action: 'peers' },
      { meshTransport: null, meshRemoteControl: null }
    );

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('not enabled'));
  });

  it('lists peers when mesh is available', async () => {
    const mockTransport = {
      getConnectedPeers: () => [
        {
          peerId: 'kl-abc123',
          displayName: 'Desktop',
          capabilities: ['gpu'],
          connectedAt: Date.now(),
          lastSeen: Date.now()
        }
      ]
    };

    const result = await RemoteDispatchTool.execute(
      { action: 'peers' },
      { meshTransport: mockTransport, meshRemoteControl: {} }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.peers.length, 1);
    assert.strictEqual(result.peers[0].peerId, 'kl-abc123');
    assert.strictEqual(result.peers[0].displayName, 'Desktop');
  });

  it('returns empty peers message when none connected', async () => {
    const mockTransport = {
      getConnectedPeers: () => []
    };

    const result = await RemoteDispatchTool.execute(
      { action: 'peers' },
      { meshTransport: mockTransport, meshRemoteControl: {} }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.peers.length, 0);
    assert.ok(result.message.includes('No peers'));
  });

  it('requires message for dispatch', async () => {
    const mockTransport = { getConnectedPeers: () => [] };
    const mockRC = { findPeerByCapability: () => null };

    const result = await RemoteDispatchTool.execute(
      { action: 'dispatch', peer: 'kl-abc' },
      { meshTransport: mockTransport, meshRemoteControl: mockRC }
    );

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Message is required'));
  });

  it('requires peer for dispatch', async () => {
    const mockTransport = { getConnectedPeers: () => [] };
    const mockRC = {};

    const result = await RemoteDispatchTool.execute(
      { action: 'dispatch', message: 'build it' },
      { meshTransport: mockTransport, meshRemoteControl: mockRC }
    );

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('Peer is required'));
  });

  it('returns status when no taskId provided', async () => {
    const mockTransport = { getConnectedPeers: () => [] };
    const mockRC = {
      getStatus: () => ({ pendingTasks: 0, activeTasks: 0, tasks: { pending: [], active: [] } })
    };

    const result = await RemoteDispatchTool.execute(
      { action: 'status' },
      { meshTransport: mockTransport, meshRemoteControl: mockRC }
    );

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.pendingTasks, 0);
  });

  it('requires both taskId and peer for cancel', async () => {
    const mockTransport = { getConnectedPeers: () => [] };

    const result = await RemoteDispatchTool.execute(
      { action: 'cancel', taskId: 'task-1' },
      { meshTransport: mockTransport, meshRemoteControl: {} }
    );

    assert.strictEqual(result.success, false);
    assert.ok(result.error.includes('required'));
  });
});
