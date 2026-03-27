const { ChannelPlugin } = require('../channels/channel-plugin');

class MeshChannel extends ChannelPlugin {
  constructor(config = {}) {
    super({
      id: 'mesh',
      label: 'Mesh Network',
      capabilities: ['send', 'receive']
    });

    this.transport = config.transport;
    this.sessionManager = config.sessionManager;
    this.gateway = null;
    this.messageHandler = null;
  }

  async initialize(gateway) {
    this.gateway = gateway;

    this.transport.on('peerMessage', (msg) => {
      this._handleInboundMessage(msg);
    });

    this.transport.on('peerConnected', (peer) => {
      if (this.gateway) {
        this.gateway.broadcast('mesh:peerConnected', {
          peerId: peer.peerId,
          displayName: peer.displayName,
          capabilities: peer.capabilities
        });
      }
    });

    this.transport.on('peerDisconnected', (info) => {
      if (this.gateway) {
        this.gateway.broadcast('mesh:peerDisconnected', {
          peerId: info.peerId,
          reason: info.reason
        });
      }
    });
  }

  async shutdown() {
    this.gateway = null;
    this.messageHandler = null;
  }

  normalizeTarget(rawTarget) {
    if (!rawTarget) return '';
    return String(rawTarget).trim();
  }

  async send(target, message, _options = {}) {
    const peerId = this.normalizeTarget(target);
    if (!peerId) {
      throw new Error('Target peer ID is required');
    }

    this.transport.send(peerId, {
      method: 'mesh.channel.message',
      params: {
        content: typeof message === 'string' ? message : message.content || '',
        from: this.transport.identity.peerId
      }
    });

    return { status: 'sent', peerId };
  }

  async onMessage(handler) {
    this.messageHandler = handler;
  }

  async listTargets() {
    return this.transport.getConnectedPeers().map((peer) => ({
      id: peer.peerId,
      name: peer.displayName || peer.peerId,
      type: 'peer'
    }));
  }

  getStatus() {
    const peers = this.transport.getConnectedPeers();
    return {
      connected: peers.length > 0,
      peerCount: peers.length,
      peers: peers.map((p) => ({
        peerId: p.peerId,
        displayName: p.displayName,
        capabilities: p.capabilities
      }))
    };
  }

  _handleInboundMessage(msg) {
    const { from, payload } = msg;

    if (payload.method !== 'mesh.channel.message') return;

    const normalized = {
      channel: 'mesh',
      sender: {
        id: from,
        name: this._getPeerDisplayName(from),
        isGroup: false
      },
      group: null,
      text: payload.params?.content || '',
      mentions: [],
      attachments: [],
      raw: msg
    };

    if (this.messageHandler) {
      this.messageHandler(normalized).catch((err) => {
        console.error(`[mesh-channel] message handler error:`, err.message);
      });
    }

    if (this.gateway) {
      const agentId = this.sessionManager
        ? this.sessionManager.resolveAgentRoute('mesh', null, from)
        : 'main';

      const sessionKey = this.sessionManager
        ? this.sessionManager.buildSessionKey(agentId, 'mesh', from)
        : `agent:main:mesh:${from}`;

      this.gateway.sendToAgent(agentId, sessionKey, {
        message: normalized.text,
        from: `mesh:${from}`,
        channel: 'mesh',
        sender: normalized.sender
      });
    }
  }

  _getPeerDisplayName(peerId) {
    const peer = this.transport.getPeer(peerId);
    return peer?.displayName || peerId;
  }
}

module.exports = { MeshChannel };
