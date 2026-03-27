const { EventEmitter } = require('events');

const DEFAULT_TASK_TIMEOUT_MS = 300000; // 5 minutes

class MeshRemoteControl extends EventEmitter {
  constructor(config = {}) {
    super();
    this.transport = config.transport;
    this.sessionManager = config.sessionManager;
    this.agentExecutor = config.agentExecutor;
    this.taskManager = config.taskManager;
    this.getAgent = config.getAgent || (() => null);

    this.pendingTasks = new Map();
    this.activeTasks = new Map();

    this._setupHandlers();
  }

  _setupHandlers() {
    this.transport.on('peerMessage', (msg) => {
      this._routeMessage(msg);
    });
  }

  _routeMessage(msg) {
    const { from, payload } = msg;
    const { method, params, id } = payload;

    const handlers = {
      'mesh.task.dispatch': (p) => this._handleTaskDispatch(from, id, p),
      'mesh.task.status': (p) => this._handleTaskStatus(from, id, p),
      'mesh.task.cancel': (p) => this._handleTaskCancel(from, id, p),
      'mesh.peer.capabilities': () => this._handleCapabilities(from, id),
      'mesh.peer.heartbeat': () => {} // handled by transport
    };

    // Handle RPC responses (results for tasks we dispatched)
    if (!method && id) {
      return; // response handled by transport.sendRpc promise
    }

    const handler = handlers[method];
    if (handler) {
      handler(params || {}).catch((err) => {
        console.error(`[mesh-rc] handler error for ${method}:`, err.message);
        try {
          this.transport.sendRpcResponse(from, id, null, err);
        } catch { /* peer might be disconnected */ }
      });
    }
  }

  // --- Outbound: Dispatch task to a remote peer ---

  async dispatchTask(peerId, taskConfig = {}) {
    const {
      message,
      agentId = 'main',
      timeout = DEFAULT_TASK_TIMEOUT_MS,
      metadata = {}
    } = taskConfig;

    if (!message) throw new Error('Task message is required');

    const peer = this.transport.getPeer(peerId);
    if (!peer) throw new Error(`Peer not connected: ${peerId}`);

    const taskId = `mesh-task-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    // Track locally in TaskManager if available
    let localTask = null;
    if (this.taskManager) {
      localTask = this.taskManager.create({
        id: taskId,
        subject: `Remote: ${message.slice(0, 60)}`,
        description: message,
        activeForm: `Executing on ${peer.displayName || peerId}`,
        metadata: {
          remote: true,
          targetPeer: peerId,
          targetPeerName: peer.displayName || peerId,
          agentId,
          dispatchedAt: Date.now(),
          ...metadata
        }
      });
      this.taskManager.markInProgress(taskId);
    }

    // Track in pending tasks
    this.pendingTasks.set(taskId, {
      peerId,
      taskId,
      message,
      agentId,
      status: 'dispatched',
      dispatchedAt: Date.now(),
      timeout
    });

    try {
      const result = await Promise.race([
        this.transport.sendRpc(peerId, 'mesh.task.dispatch', {
          taskId,
          message,
          agentId
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Task dispatch timeout')), timeout)
        )
      ]);

      this.pendingTasks.delete(taskId);

      if (this.taskManager && localTask) {
        this.taskManager.markCompleted(taskId);
      }

      this.emit('taskCompleted', {
        taskId,
        peerId,
        result
      });

      return { taskId, status: 'completed', result };
    } catch (err) {
      this.pendingTasks.delete(taskId);

      if (this.taskManager && localTask) {
        this.taskManager.update(taskId, {
          status: 'completed',
          metadata: {
            ...localTask.metadata,
            error: err.message,
            failedAt: Date.now()
          }
        });
      }

      this.emit('taskFailed', {
        taskId,
        peerId,
        error: err.message
      });

      throw err;
    }
  }

  async queryTaskStatus(peerId, taskId) {
    return this.transport.sendRpc(peerId, 'mesh.task.status', { taskId });
  }

  async cancelTask(peerId, taskId) {
    this.pendingTasks.delete(taskId);
    return this.transport.sendRpc(peerId, 'mesh.task.cancel', { taskId });
  }

  async queryPeerCapabilities(peerId) {
    return this.transport.sendRpc(peerId, 'mesh.peer.capabilities', {});
  }

  // --- Find peer by capability ---

  findPeerByCapability(requiredCapabilities = []) {
    const connectedPeers = this.transport.getConnectedPeers();

    for (const peer of connectedPeers) {
      const hasAll = requiredCapabilities.every((cap) =>
        peer.capabilities.includes(cap)
      );
      if (hasAll) return peer;
    }

    return null;
  }

  findAllPeersByCapability(requiredCapabilities = []) {
    return this.transport.getConnectedPeers().filter((peer) =>
      requiredCapabilities.every((cap) => peer.capabilities.includes(cap))
    );
  }

  // --- Inbound: Handle task dispatched to us ---

  async _handleTaskDispatch(fromPeerId, rpcId, params) {
    const { taskId, message, agentId = 'main' } = params;

    if (!message) {
      this.transport.sendRpcResponse(fromPeerId, rpcId, null, 'message is required');
      return;
    }

    // Track as active task
    this.activeTasks.set(taskId, {
      taskId,
      fromPeerId,
      rpcId,
      message,
      agentId,
      status: 'running',
      startedAt: Date.now()
    });

    this.emit('taskReceived', { taskId, fromPeerId, message, agentId });

    try {
      const agent = this.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const sessionKey = this.sessionManager.buildSessionKey(agentId, 'mesh', fromPeerId);
      const session = this.sessionManager.getOrCreateSession(sessionKey, agentId, {
        remotePeer: fromPeerId,
        remoteTaskId: taskId
      });

      this.sessionManager.addMessage(session.key, {
        role: 'user',
        content: message,
        source: 'mesh',
        from: `mesh:${fromPeerId}`,
        metadata: { remoteTaskId: taskId }
      });

      const result = await this.agentExecutor.execute(agent, message, {
        sessionKey: session.key
      });

      this.sessionManager.addMessage(session.key, {
        role: 'assistant',
        content: result.content || '',
        source: 'mesh'
      });

      this.activeTasks.delete(taskId);

      this.transport.sendRpcResponse(fromPeerId, rpcId, {
        taskId,
        status: 'completed',
        content: result.content || '',
        iterations: result.iterations,
        tools: result.tools
      });
    } catch (err) {
      this.activeTasks.delete(taskId);

      this.transport.sendRpcResponse(fromPeerId, rpcId, null,
        `Task execution failed: ${err.message}`
      );
    }
  }

  async _handleTaskStatus(fromPeerId, rpcId, params) {
    const { taskId } = params;
    const active = this.activeTasks.get(taskId);

    if (!active) {
      this.transport.sendRpcResponse(fromPeerId, rpcId, {
        taskId,
        status: 'unknown'
      });
      return;
    }

    this.transport.sendRpcResponse(fromPeerId, rpcId, {
      taskId,
      status: active.status,
      startedAt: active.startedAt,
      agentId: active.agentId
    });
  }

  async _handleTaskCancel(fromPeerId, rpcId, params) {
    const { taskId } = params;
    const active = this.activeTasks.get(taskId);

    if (active) {
      active.status = 'cancelled';
      this.activeTasks.delete(taskId);
      this.emit('taskCancelled', { taskId, fromPeerId });
    }

    this.transport.sendRpcResponse(fromPeerId, rpcId, {
      taskId,
      status: 'cancelled'
    });
  }

  async _handleCapabilities(fromPeerId, rpcId) {
    this.transport.sendRpcResponse(fromPeerId, rpcId, {
      peerId: this.transport.identity.peerId,
      displayName: this.transport.identity.displayName,
      capabilities: this.transport.identity.capabilities
    });
  }

  // --- Status ---

  getStatus() {
    return {
      pendingTasks: this.pendingTasks.size,
      activeTasks: this.activeTasks.size,
      tasks: {
        pending: Array.from(this.pendingTasks.values()).map((t) => ({
          taskId: t.taskId,
          peerId: t.peerId,
          status: t.status,
          dispatchedAt: t.dispatchedAt
        })),
        active: Array.from(this.activeTasks.values()).map((t) => ({
          taskId: t.taskId,
          fromPeerId: t.fromPeerId,
          status: t.status,
          startedAt: t.startedAt
        }))
      }
    };
  }
}

module.exports = { MeshRemoteControl };
