const { wrapHandler } = require('./wrap-handler');
const C = require('./constants');
const { createLogger } = require('../logging');

const log = createLogger('mesh');

function registerMeshHandlers(ipcMain, context = {}) {
  const getMeshContext = () =>
    (typeof context.getMeshContext === 'function' ? context.getMeshContext() : null) ||
    context.meshContext ||
    null;

  const getStore = () =>
    (typeof context.getStore === 'function' ? context.getStore() : null) ||
    context.store ||
    null;

  ipcMain.handle(C.MESH_STATUS, wrapHandler(C.MESH_STATUS, async () => {
    const mc = getMeshContext();
    if (!mc) {
      log.warn('status requested but meshContext is null');
      return { enabled: false };
    }

    return {
      enabled: true,
      peerId: mc.identity.peerId,
      displayName: mc.identity.displayName,
      capabilities: mc.identity.capabilities,
      port: mc.transport.port,
      peers: mc.transport.getConnectedPeers(),
      discoveryAvailable: mc.discovery.isAvailable(),
      discoveredPeers: mc.discovery.getDiscoveredPeers(),
      tasks: mc.remoteControl.getStatus(),
      swarms: mc.swarm.listSwarms()
    };
  }));

  ipcMain.handle(C.MESH_PEERS_LIST, wrapHandler(C.MESH_PEERS_LIST, async () => {
    const mc = getMeshContext();
    if (!mc) return { peers: [] };

    return {
      connected: mc.transport.getConnectedPeers(),
      trusted: Array.from(mc.transport.trustedPeers.values()),
      discovered: mc.discovery.getDiscoveredPeers()
    };
  }));

  ipcMain.handle(C.MESH_PEER_ADD, wrapHandler(C.MESH_PEER_ADD, async (_event, params = {}) => {
    const mc = getMeshContext();
    if (!mc) throw new Error('Mesh not enabled');

    const { address, port } = params;
    if (!address || !port) throw new Error('address and port are required');

    const peer = await mc.transport.connectToPeer(address, Number(port));
    return { peerId: peer.peerId, displayName: peer.displayName };
  }));

  ipcMain.handle(C.MESH_PEER_REMOVE, wrapHandler(C.MESH_PEER_REMOVE, async (_event, params = {}) => {
    const mc = getMeshContext();
    if (!mc) throw new Error('Mesh not enabled');

    const { peerId } = params;
    if (!peerId) throw new Error('peerId is required');

    mc.transport.removeTrustedPeer(peerId);
    return { removed: true };
  }));

  ipcMain.handle(C.MESH_PAIR_START, wrapHandler(C.MESH_PAIR_START, async () => {
    const mc = getMeshContext();
    if (!mc) throw new Error('Mesh not enabled');

    const { pairingId, code } = mc.pairing.generateCode();
    return { pairingId, code };
  }));

  ipcMain.handle(C.MESH_PAIR_ACCEPT, wrapHandler(C.MESH_PAIR_ACCEPT, async (_event, params = {}) => {
    const mc = getMeshContext();
    if (!mc) throw new Error('Mesh not enabled');

    const { code, address, port } = params;
    if (!code || !address || !port) {
      throw new Error('code, address, and port are required');
    }

    const peer = await mc.pairing.acceptCode(code, address, Number(port));

    // Auto-connect to the newly paired peer
    try {
      await mc.transport.connectToPeer(address, Number(port));
    } catch (err) {
      log.debug(`auto-connect after pairing failed: ${err.message}`);
    }

    return { peerId: peer.peerId, displayName: peer.displayName || '' };
  }));

  ipcMain.handle(C.MESH_DISPATCH_TASK, wrapHandler(C.MESH_DISPATCH_TASK, async (_event, params = {}) => {
    const mc = getMeshContext();
    if (!mc) throw new Error('Mesh not enabled');

    const { peerId, message, agentId, timeout } = params;
    const result = await mc.remoteControl.dispatchTask(peerId, {
      message,
      agentId,
      timeout
    });

    return result;
  }));

  ipcMain.handle(C.MESH_TASK_STATUS, wrapHandler(C.MESH_TASK_STATUS, async (_event, params = {}) => {
    const mc = getMeshContext();
    if (!mc) throw new Error('Mesh not enabled');

    if (params.taskId && params.peerId) {
      return mc.remoteControl.queryTaskStatus(params.peerId, params.taskId);
    }

    return mc.remoteControl.getStatus();
  }));

  ipcMain.handle(C.MESH_SETTINGS_SAVE, wrapHandler(C.MESH_SETTINGS_SAVE, async (_event, params = {}) => {
    const store = getStore();
    if (!store) throw new Error('Store not available');

    const { displayName, capabilities, port, discoveryEnabled } = params;

    const current = store.get('settings.mesh') || {};
    const updated = {
      ...current,
      ...(displayName !== undefined && { displayName }),
      ...(capabilities !== undefined && { capabilities }),
      ...(port !== undefined && { port }),
      ...(discoveryEnabled !== undefined && { discovery: discoveryEnabled })
    };

    store.set('settings.mesh', updated);

    // Update identity in-memory if mesh is running
    const mc = getMeshContext();
    if (mc) {
      if (displayName !== undefined) mc.identity.displayName = displayName;
      if (capabilities !== undefined) mc.identity.capabilities = capabilities;

      // Persist updated identity
      store.set('mesh.identity', mc.identity.serialize());
    }

    return { saved: true, settings: updated };
  }));
}

module.exports = { registerMeshHandlers };
