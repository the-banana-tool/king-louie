const { Tool } = require('../tool-schema');

const RemoteDispatchTool = new Tool({
  name: 'RemoteDispatch',
  description: `Dispatch tasks to remote King Louie peers on the mesh network.
Use this tool to offload work to other machines (e.g., GPU-heavy builds, distributed training).

Actions:
- "peers": List connected peers and their capabilities
- "dispatch": Send a task to a specific peer for execution
- "status": Check the status of a previously dispatched task
- "cancel": Cancel a running remote task`,

  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['peers', 'dispatch', 'status', 'cancel'],
        description: 'The action to perform'
      },
      peer: {
        type: 'string',
        description: 'Target peer ID or display name (for dispatch/status/cancel). Can also be a capability query like "gpu" to auto-select a capable peer.'
      },
      message: {
        type: 'string',
        description: 'The task message/instruction to send to the remote peer (for dispatch)'
      },
      agentId: {
        type: 'string',
        description: 'Which agent to use on the remote peer (default: "main")'
      },
      timeout: {
        type: 'number',
        description: 'Task timeout in milliseconds (default: 300000 = 5 minutes)',
        minimum: 5000,
        maximum: 3600000
      },
      taskId: {
        type: 'string',
        description: 'Task ID (for status/cancel actions)'
      }
    },
    required: ['action']
  },

  requiresApproval: true,

  async execute(params, options = {}) {
    const { meshRemoteControl, meshTransport } = options;

    if (!meshTransport || !meshRemoteControl) {
      return {
        success: false,
        error: 'Mesh networking is not enabled. Enable it in Settings > Mesh Network.'
      };
    }

    const { action } = params;

    switch (action) {
      case 'peers':
        return executePeers(meshTransport);

      case 'dispatch':
        return executeDispatch(params, meshRemoteControl, meshTransport);

      case 'status':
        return executeStatus(params, meshRemoteControl);

      case 'cancel':
        return executeCancel(params, meshRemoteControl);

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  }
});

function executePeers(transport) {
  const peers = transport.getConnectedPeers();

  if (peers.length === 0) {
    return {
      success: true,
      message: 'No peers are currently connected.',
      peers: []
    };
  }

  return {
    success: true,
    message: `${peers.length} peer(s) connected.`,
    peers: peers.map((p) => ({
      peerId: p.peerId,
      displayName: p.displayName || '(unnamed)',
      capabilities: p.capabilities,
      connectedSince: new Date(p.connectedAt).toISOString(),
      lastSeen: new Date(p.lastSeen).toISOString()
    }))
  };
}

async function executeDispatch(params, remoteControl, transport) {
  const {
    peer,
    message,
    agentId = 'main',
    timeout = 300000
  } = params;

  if (!message) {
    return { success: false, error: 'Message is required for dispatch action' };
  }

  if (!peer) {
    return { success: false, error: 'Peer is required for dispatch action' };
  }

  // Resolve peer: by ID, by display name, or by capability
  const resolvedPeerId = resolvePeer(peer, transport, remoteControl);
  if (!resolvedPeerId) {
    return {
      success: false,
      error: `Could not find a connected peer matching "${peer}". Use action "peers" to list available peers.`
    };
  }

  try {
    const result = await remoteControl.dispatchTask(resolvedPeerId, {
      message,
      agentId,
      timeout
    });

    return {
      success: true,
      taskId: result.taskId,
      status: result.status,
      content: result.result?.content || '',
      peer: resolvedPeerId
    };
  } catch (err) {
    return {
      success: false,
      error: `Task dispatch failed: ${err.message}`,
      peer: resolvedPeerId
    };
  }
}

async function executeStatus(params, remoteControl) {
  const { taskId, peer } = params;

  if (!taskId) {
    const status = remoteControl.getStatus();
    return {
      success: true,
      ...status
    };
  }

  if (!peer) {
    return { success: false, error: 'Peer is required to query task status' };
  }

  try {
    const result = await remoteControl.queryTaskStatus(peer, taskId);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function executeCancel(params, remoteControl) {
  const { taskId, peer } = params;

  if (!taskId || !peer) {
    return { success: false, error: 'Both taskId and peer are required for cancel' };
  }

  try {
    const result = await remoteControl.cancelTask(peer, taskId);
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function resolvePeer(peerQuery, transport, remoteControl) {
  const connected = transport.getConnectedPeers();

  // Exact peer ID match
  const byId = connected.find((p) => p.peerId === peerQuery);
  if (byId) return byId.peerId;

  // Display name match (case-insensitive)
  const lowerQuery = peerQuery.toLowerCase();
  const byName = connected.find((p) =>
    (p.displayName || '').toLowerCase() === lowerQuery
  );
  if (byName) return byName.peerId;

  // Partial name match
  const byPartial = connected.find((p) =>
    (p.displayName || '').toLowerCase().includes(lowerQuery)
  );
  if (byPartial) return byPartial.peerId;

  // Capability match - find first peer with this capability
  const byCap = remoteControl.findPeerByCapability([peerQuery]);
  if (byCap) return byCap.peerId;

  return null;
}

module.exports = RemoteDispatchTool;
