const { MeshIdentity } = require('./mesh-identity');
const { MeshTransport, DEFAULT_PORT } = require('./mesh-transport');
const { MeshPairing } = require('./mesh-pairing');
const { MeshChannel } = require('./mesh-channel');
const { MeshRemoteControl } = require('./mesh-remote-control');
const { MeshDiscovery } = require('./mesh-discovery');
const { MeshSwarm } = require('./mesh-swarm');
const { createLogger } = require('../logging');
const log = createLogger('mesh');

async function initializeMesh(config = {}) {
  const {
    store,
    sessionManager,
    agentExecutor,
    taskManager,
    channelRegistry,
    getAgent,
    settings = {}
  } = config;

  const meshSettings = settings.mesh || {};
  if (meshSettings.enabled === false) {
    log.info('disabled by settings');
    return null;
  }

  // Load or create identity
  let identity;
  const stored = store.get('mesh.identity');
  if (stored) {
    try {
      identity = MeshIdentity.deserialize(stored);
      // Apply any updated settings
      identity.displayName = meshSettings.displayName || stored.displayName || '';
      identity.capabilities = meshSettings.capabilities || stored.capabilities || [];
    } catch (err) {
      log.warn(`failed to load stored identity, generating new one: ${err.message}`);
      identity = null;
    }
  }

  if (!identity) {
    identity = new MeshIdentity({
      displayName: meshSettings.displayName || '',
      capabilities: meshSettings.capabilities || []
    });
    store.set('mesh.identity', identity.serialize());
    log.info(`generated new identity: ${identity.peerId}`);
  }

  // Encrypt private key if safeStorage is available
  try {
    const { safeStorage } = require('electron');
    if (safeStorage.isEncryptionAvailable()) {
      const encryptedKey = safeStorage.encryptString(identity.privateKey.toString('hex'));
      store.set('mesh.encryptedPrivateKey', encryptedKey.toString('base64'));
    }
  } catch {
    // Not in Electron context or safeStorage unavailable
  }

  const port = meshSettings.port || (process.env.KL_TEST_MODE ? 0 : DEFAULT_PORT);

  // Create transport (TLS enabled by default)
  const transport = new MeshTransport({
    identity,
    port,
    host: meshSettings.host || '0.0.0.0',
    useTls: meshSettings.useTls !== false
  });

  // Load trusted peers from store (including pinned TLS fingerprints)
  const trustedPeers = store.get('mesh.trustedPeers') || {};
  for (const [peerId, peerData] of Object.entries(trustedPeers)) {
    transport.addTrustedPeer(peerId, peerData.publicKey, {
      displayName: peerData.displayName,
      capabilities: peerData.capabilities,
      tlsFingerprint: peerData.tlsFingerprint || null,
      address: peerData.address,
      port: peerData.port
    });
  }

  // Create pairing and wire it into the transport
  const pairing = new MeshPairing(identity, transport);
  transport.onPairingRequest = (ws, msg) => pairing.handlePairingRequest(ws, msg);

  // Create channel
  const meshChannel = new MeshChannel({
    transport,
    sessionManager
  });

  // Create remote control
  const remoteControl = new MeshRemoteControl({
    transport,
    sessionManager,
    agentExecutor,
    taskManager,
    getAgent
  });

  // Create discovery
  const discovery = new MeshDiscovery({
    identity,
    port,
    enabled: meshSettings.discovery !== false
  });

  // Create swarm
  const swarm = new MeshSwarm({
    transport,
    remoteControl,
    taskManager,
    getAgent
  });

  // Wire up discovery → auto-connect
  discovery.on('peerDiscovered', async (peerInfo) => {
    if (transport.trustedPeers.has(peerInfo.peerId) && !transport.getPeer(peerInfo.peerId)) {
      try {
        await transport.connectToPeer(peerInfo.address, peerInfo.port);
      } catch (err) {
        log.debug(`auto-connect to discovered peer ${peerInfo.peerId} failed: ${err.message}`);
      }
    }
  });

  // Wire up transport peer changes → persist trust data
  transport.on('peerConnected', () => {
    _persistTrustedPeers(store, transport);
  });

  // Start everything
  try {
    await transport.start();
    await discovery.start();

    if (channelRegistry) {
      channelRegistry.register(meshChannel);
    }

    // Auto-connect to known peers with addresses
    for (const [peerId, peerData] of transport.trustedPeers) {
      if (peerData.address && peerData.port && !transport.getPeer(peerId)) {
        transport.connectToPeer(peerData.address, peerData.port).catch(() => {
          // Will retry via reconnect logic
        });
      }
    }

    log.info(`initialized - peer ID: ${identity.peerId}, port: ${port}`);
  } catch (err) {
    log.error(`initialization failed: ${err.message}`);
  }

  return {
    identity,
    transport,
    pairing,
    channel: meshChannel,
    remoteControl,
    discovery,
    swarm,

    async shutdown() {
      pairing.cleanup();
      await discovery.stop();
      await transport.stop();
      if (channelRegistry) {
        channelRegistry.unregister('mesh');
      }
    }
  };
}

function _persistTrustedPeers(store, transport) {
  const data = {};
  for (const [peerId, peer] of transport.trustedPeers) {
    data[peerId] = {
      peerId: peer.peerId,
      publicKey: peer.publicKey,
      displayName: peer.displayName,
      capabilities: peer.capabilities,
      tlsFingerprint: peer.tlsFingerprint || null,
      address: peer.address,
      port: peer.port
    };
  }
  store.set('mesh.trustedPeers', data);
}

module.exports = {
  MeshIdentity,
  MeshTransport,
  MeshPairing,
  MeshChannel,
  MeshRemoteControl,
  MeshDiscovery,
  MeshSwarm,
  initializeMesh,
  DEFAULT_PORT
};
