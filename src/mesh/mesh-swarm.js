const { EventEmitter } = require('events');

class MeshSwarm extends EventEmitter {
  constructor(config = {}) {
    super();
    this.transport = config.transport;
    this.remoteControl = config.remoteControl;
    this.taskManager = config.taskManager;
    this.getAgent = config.getAgent || (() => null);

    this.activeSwarms = new Map();
    this._setupHandlers();
  }

  _setupHandlers() {
    this.transport.on('peerMessage', (msg) => {
      const { method } = msg.payload || {};
      if (method === 'mesh.swarm.propose') {
        this._handleProposal(msg.from, msg.payload.id, msg.payload.params);
      } else if (method === 'mesh.swarm.accept') {
        this._handleAcceptance(msg.from, msg.payload.params);
      } else if (method === 'mesh.swarm.progress') {
        this._handleProgress(msg.from, msg.payload.params);
      }
    });
  }

  // --- Coordinator: Create and manage a swarm task ---

  async createSwarm(config = {}) {
    const {
      name,
      description,
      subtasks, // [{ subject, message, agentId, capabilities, blockedBy }]
      timeout = 600000
    } = config;

    if (!subtasks || subtasks.length === 0) {
      throw new Error('At least one subtask is required');
    }

    const swarmId = `swarm-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    // Create tasks in TaskManager with dependency graph
    const taskMap = new Map();
    const tasks = [];

    for (const sub of subtasks) {
      const task = this.taskManager.create({
        subject: sub.subject || sub.message.slice(0, 60),
        description: sub.message,
        activeForm: sub.activeForm || `Running: ${sub.subject || 'subtask'}`,
        blockedBy: (sub.blockedBy || []).map((ref) => {
          const mapped = taskMap.get(ref);
          return mapped ? mapped.id : ref;
        }),
        metadata: {
          swarmId,
          requiredCapabilities: sub.capabilities || [],
          agentId: sub.agentId || 'main',
          targetPeer: sub.targetPeer || null,
          message: sub.message,
          localIndex: tasks.length
        }
      });

      if (sub.ref) {
        taskMap.set(sub.ref, task);
      }
      taskMap.set(tasks.length, task);
      tasks.push(task);
    }

    const swarm = {
      id: swarmId,
      name: name || `Swarm ${swarmId}`,
      description: description || '',
      tasks: tasks.map((t) => t.id),
      assignments: new Map(),
      results: new Map(),
      status: 'proposing',
      createdAt: Date.now(),
      timeout
    };

    this.activeSwarms.set(swarmId, swarm);
    this.emit('swarmCreated', { swarmId, name: swarm.name, taskCount: tasks.length });

    return { swarmId, tasks };
  }

  async proposeSwarm(swarmId) {
    const swarm = this.activeSwarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);

    const connectedPeers = this.transport.getConnectedPeers();
    const tasks = swarm.tasks.map((id) => this.taskManager.get(id)).filter(Boolean);

    // Send proposals to all connected peers
    const proposals = [];
    for (const task of tasks) {
      const required = task.metadata.requiredCapabilities || [];

      // If a specific peer is targeted, only propose to that peer
      if (task.metadata.targetPeer) {
        proposals.push({
          taskId: task.id,
          peerId: task.metadata.targetPeer,
          task: {
            subject: task.subject,
            message: task.metadata.message,
            agentId: task.metadata.agentId,
            capabilities: required
          }
        });
        continue;
      }

      // Find capable peers
      const capable = connectedPeers.filter((peer) =>
        required.every((cap) => peer.capabilities.includes(cap))
      );

      if (capable.length === 0 && required.length > 0) {
        // No capable peer found - will execute locally
        proposals.push({
          taskId: task.id,
          peerId: 'local',
          task: {
            subject: task.subject,
            message: task.metadata.message,
            agentId: task.metadata.agentId,
            capabilities: required
          }
        });
      } else if (capable.length > 0) {
        // Propose to the first capable peer (round-robin could be added later)
        const peer = capable[0];
        proposals.push({
          taskId: task.id,
          peerId: peer.peerId,
          task: {
            subject: task.subject,
            message: task.metadata.message,
            agentId: task.metadata.agentId,
            capabilities: required
          }
        });
      } else {
        // No specific capabilities required - assign locally
        proposals.push({
          taskId: task.id,
          peerId: 'local',
          task: {
            subject: task.subject,
            message: task.metadata.message,
            agentId: task.metadata.agentId,
            capabilities: []
          }
        });
      }
    }

    // Send proposals to remote peers
    const peerProposals = new Map();
    for (const prop of proposals) {
      if (prop.peerId === 'local') {
        swarm.assignments.set(prop.taskId, 'local');
        continue;
      }

      if (!peerProposals.has(prop.peerId)) {
        peerProposals.set(prop.peerId, []);
      }
      peerProposals.get(prop.peerId).push(prop);
    }

    const responses = [];
    for (const [peerId, peerProps] of peerProposals) {
      try {
        const result = await this.transport.sendRpc(peerId, 'mesh.swarm.propose', {
          swarmId,
          swarmName: swarm.name,
          tasks: peerProps.map((p) => ({
            taskId: p.taskId,
            ...p.task
          }))
        });

        for (const accepted of result.accepted || []) {
          swarm.assignments.set(accepted.taskId, peerId);
          responses.push({ taskId: accepted.taskId, peerId, accepted: true });
        }
        for (const rejected of result.rejected || []) {
          swarm.assignments.set(rejected.taskId, 'local'); // fallback
          responses.push({ taskId: rejected.taskId, peerId, accepted: false, reason: rejected.reason });
        }
      } catch (err) {
        // Peer unreachable - fallback to local
        for (const prop of peerProps) {
          swarm.assignments.set(prop.taskId, 'local');
          responses.push({ taskId: prop.taskId, peerId, accepted: false, reason: err.message });
        }
      }
    }

    swarm.status = 'assigned';
    this.emit('swarmAssigned', { swarmId, assignments: Object.fromEntries(swarm.assignments) });

    return { swarmId, proposals, responses };
  }

  async executeSwarm(swarmId) {
    const swarm = this.activeSwarms.get(swarmId);
    if (!swarm) throw new Error(`Swarm not found: ${swarmId}`);

    swarm.status = 'executing';
    this.emit('swarmExecuting', { swarmId });

    // Listen for task unblocking
    const onUnblocked = async (task) => {
      if (!swarm.tasks.includes(task.id)) return;
      await this._executeSwarmTask(swarm, task);
    };

    this.taskManager.on('taskUnblocked', onUnblocked);

    // Execute initially available tasks
    const available = swarm.tasks
      .map((id) => this.taskManager.get(id))
      .filter((t) => t && t.canStart());

    const execPromises = available.map((task) =>
      this._executeSwarmTask(swarm, task)
    );

    // Wait for all tasks to complete (with timeout)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.taskManager.removeListener('taskUnblocked', onUnblocked);
        swarm.status = 'timeout';
        reject(new Error(`Swarm ${swarmId} timed out`));
      }, swarm.timeout);

      const checkComplete = () => {
        const allTasks = swarm.tasks.map((id) => this.taskManager.get(id));
        const allDone = allTasks.every((t) =>
          t.status === 'completed' || t.status === 'deleted'
        );

        if (allDone) {
          clearTimeout(timeout);
          this.taskManager.removeListener('taskUnblocked', onUnblocked);
          swarm.status = 'completed';

          this.emit('swarmCompleted', {
            swarmId,
            results: Object.fromEntries(swarm.results)
          });

          resolve({
            swarmId,
            status: 'completed',
            results: Object.fromEntries(swarm.results)
          });
        }
      };

      this.taskManager.on('taskUpdated', (task) => {
        if (swarm.tasks.includes(task.id) && task.status === 'completed') {
          checkComplete();
        }
      });

      // Initial check in case tasks are already all done (e.g. cached)
      Promise.all(execPromises).then(checkComplete).catch(reject);
    });
  }

  async _executeSwarmTask(swarm, task) {
    const assignedPeer = swarm.assignments.get(task.id) || 'local';

    this.taskManager.markInProgress(task.id);

    try {
      let result;

      if (assignedPeer === 'local') {
        // Execute locally via agent executor (handled by the calling agent)
        result = { content: `[local execution of: ${task.metadata.message}]`, local: true };
      } else {
        result = await this.remoteControl.dispatchTask(assignedPeer, {
          message: task.metadata.message,
          agentId: task.metadata.agentId
        });
      }

      swarm.results.set(task.id, {
        status: 'completed',
        peer: assignedPeer,
        result
      });

      this.taskManager.markCompleted(task.id);

      this.emit('swarmTaskCompleted', {
        swarmId: swarm.id,
        taskId: task.id,
        peer: assignedPeer,
        result
      });
    } catch (err) {
      swarm.results.set(task.id, {
        status: 'failed',
        peer: assignedPeer,
        error: err.message
      });

      // Try to reassign to another peer or local
      const fallbackPeer = this._findFallbackPeer(swarm, task, assignedPeer);
      if (fallbackPeer) {
        swarm.assignments.set(task.id, fallbackPeer);
        this.taskManager.update(task.id, { status: 'pending' });
        await this._executeSwarmTask(swarm, task);
      } else {
        this.taskManager.update(task.id, { status: 'completed' });
        this.emit('swarmTaskFailed', {
          swarmId: swarm.id,
          taskId: task.id,
          peer: assignedPeer,
          error: err.message
        });
      }
    }
  }

  _findFallbackPeer(swarm, task, failedPeer) {
    const required = task.metadata.requiredCapabilities || [];
    const connected = this.transport.getConnectedPeers();

    const candidate = connected.find((p) =>
      p.peerId !== failedPeer &&
      required.every((cap) => p.capabilities.includes(cap))
    );

    if (candidate) return candidate.peerId;
    if (failedPeer !== 'local') return 'local';
    return null;
  }

  // --- Participant: Handle swarm proposals ---

  async _handleProposal(fromPeerId, rpcId, params) {
    const { swarmId, swarmName, tasks } = params;

    const accepted = [];
    const rejected = [];

    for (const task of tasks || []) {
      // Simple acceptance policy: accept if not currently overloaded
      const activeTasks = this.remoteControl.activeTasks.size;
      if (activeTasks >= 5) {
        rejected.push({ taskId: task.taskId, reason: 'overloaded' });
      } else {
        accepted.push({ taskId: task.taskId });
      }
    }

    this.transport.sendRpcResponse(fromPeerId, rpcId, {
      swarmId,
      accepted,
      rejected
    });

    if (accepted.length > 0) {
      this.emit('swarmJoined', {
        swarmId,
        swarmName,
        coordinator: fromPeerId,
        acceptedTasks: accepted.length
      });
    }
  }

  _handleAcceptance(fromPeerId, params) {
    const { swarmId } = params;
    const swarm = this.activeSwarms.get(swarmId);
    if (!swarm) return;

    this.emit('swarmPeerAccepted', { swarmId, peerId: fromPeerId });
  }

  _handleProgress(fromPeerId, params) {
    const { swarmId, taskId, progress, message, metrics } = params;

    this.emit('swarmProgress', {
      swarmId,
      taskId,
      peerId: fromPeerId,
      progress,
      message,
      metrics
    });
  }

  // --- Status ---

  getSwarm(swarmId) {
    return this.activeSwarms.get(swarmId) || null;
  }

  listSwarms() {
    return Array.from(this.activeSwarms.values()).map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      taskCount: s.tasks.length,
      completedCount: Array.from(s.results.values()).filter((r) => r.status === 'completed').length,
      createdAt: s.createdAt
    }));
  }
}

module.exports = { MeshSwarm };
