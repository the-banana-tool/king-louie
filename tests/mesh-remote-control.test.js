const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { MeshRemoteControl } = require('../src/mesh/mesh-remote-control');
const { TaskManager } = require('../src/tasks/task-manager');

// Mock transport
class MockTransport extends EventEmitter {
  constructor(identity) {
    super();
    this.identity = identity || { peerId: 'kl-local', displayName: 'Local', capabilities: [] };
    this.sentMessages = [];
    this.peers = new Map();
  }

  getPeer(peerId) {
    return this.peers.get(peerId) || null;
  }

  getConnectedPeers() {
    return Array.from(this.peers.values());
  }

  send(peerId, payload) {
    this.sentMessages.push({ peerId, payload });
  }

  sendRpcResponse(peerId, id, result, error) {
    this.sentMessages.push({ peerId, id, result, error, type: 'rpcResponse' });
  }

  async sendRpc(peerId, method, params) {
    // Simulate immediate success
    return { taskId: params.taskId, status: 'completed', content: `Executed: ${params.message}` };
  }

  addPeer(peerId, info) {
    this.peers.set(peerId, { peerId, ...info });
  }
}

// Mock session manager
class MockSessionManager {
  constructor() {
    this.sessions = new Map();
  }

  buildSessionKey(agentId, channel, peer) {
    return peer ? `agent:${agentId}:${channel}:${peer}` : `agent:${agentId}:main`;
  }

  getOrCreateSession(key, agentId, metadata = {}) {
    if (!this.sessions.has(key)) {
      this.sessions.set(key, { key, agentId, messages: [], metadata });
    }
    return this.sessions.get(key);
  }

  addMessage(key, message) {
    const session = this.sessions.get(key);
    if (session) session.messages.push(message);
  }
}

// Mock agent executor
class MockAgentExecutor {
  async execute(_agent, message) {
    return { content: `Response to: ${message}`, iterations: 1, tools: [] };
  }
}

describe('MeshRemoteControl', () => {
  let transport, sessionManager, agentExecutor, taskManager, remoteControl;

  beforeEach(() => {
    transport = new MockTransport();
    sessionManager = new MockSessionManager();
    agentExecutor = new MockAgentExecutor();
    taskManager = new TaskManager();

    remoteControl = new MeshRemoteControl({
      transport,
      sessionManager,
      agentExecutor,
      taskManager,
      getAgent: (id) => (id === 'main' ? { id: 'main', name: 'Main' } : null)
    });
  });

  it('dispatches a task to a remote peer', async () => {
    transport.addPeer('kl-remote', { displayName: 'Remote Desktop', capabilities: ['gpu'] });

    const result = await remoteControl.dispatchTask('kl-remote', {
      message: 'Build the project',
      agentId: 'main'
    });

    assert.strictEqual(result.status, 'completed');
    assert.ok(result.taskId);
  });

  it('throws when dispatching to disconnected peer', async () => {
    await assert.rejects(
      () => remoteControl.dispatchTask('kl-nonexistent', { message: 'test' }),
      (err) => {
        assert.ok(err.message.includes('not connected'));
        return true;
      }
    );
  });

  it('creates a local task when dispatching remotely', async () => {
    transport.addPeer('kl-remote', { displayName: 'Remote', capabilities: [] });

    await remoteControl.dispatchTask('kl-remote', {
      message: 'Run tests'
    });

    const tasks = taskManager.list();
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].metadata.remote, true);
    assert.strictEqual(tasks[0].metadata.targetPeer, 'kl-remote');
  });

  it('finds peers by capability', () => {
    transport.addPeer('kl-a', { displayName: 'A', capabilities: ['gpu', 'build'] });
    transport.addPeer('kl-b', { displayName: 'B', capabilities: ['build'] });
    transport.addPeer('kl-c', { displayName: 'C', capabilities: [] });

    const gpuPeer = remoteControl.findPeerByCapability(['gpu']);
    assert.strictEqual(gpuPeer.peerId, 'kl-a');

    const buildPeers = remoteControl.findAllPeersByCapability(['build']);
    assert.strictEqual(buildPeers.length, 2);

    const noPeer = remoteControl.findPeerByCapability(['ml-training']);
    assert.strictEqual(noPeer, null);
  });

  it('handles inbound task dispatch', async () => {
    const taskReceived = new Promise((resolve) => {
      remoteControl.once('taskReceived', resolve);
    });

    // Simulate inbound task dispatch from a peer
    transport.emit('peerMessage', {
      from: 'kl-remote',
      payload: {
        method: 'mesh.task.dispatch',
        id: 'rpc-1',
        params: {
          taskId: 'task-remote-1',
          message: 'Hello from remote peer',
          agentId: 'main'
        }
      }
    });

    const event = await taskReceived;
    assert.strictEqual(event.taskId, 'task-remote-1');
    assert.strictEqual(event.fromPeerId, 'kl-remote');
    assert.strictEqual(event.message, 'Hello from remote peer');

    // Should have sent a response back
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = transport.sentMessages.find((m) => m.type === 'rpcResponse');
    assert.ok(response);
    assert.ok(response.result?.content?.includes('Response to: Hello from remote peer'));
  });

  it('handles capabilities query', async () => {
    transport.emit('peerMessage', {
      from: 'kl-remote',
      payload: {
        method: 'mesh.peer.capabilities',
        id: 'rpc-2',
        params: {}
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = transport.sentMessages.find((m) =>
      m.type === 'rpcResponse' && m.id === 'rpc-2'
    );
    assert.ok(response);
    assert.strictEqual(response.result.peerId, 'kl-local');
  });

  it('reports status correctly', () => {
    const status = remoteControl.getStatus();
    assert.strictEqual(status.pendingTasks, 0);
    assert.strictEqual(status.activeTasks, 0);
    assert.ok(Array.isArray(status.tasks.pending));
    assert.ok(Array.isArray(status.tasks.active));
  });
});
