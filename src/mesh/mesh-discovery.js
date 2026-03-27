const { EventEmitter } = require('events');

const SERVICE_TYPE = 'kinglouie';
const SERVICE_PROTOCOL = 'tcp';
const DISCOVERY_INTERVAL_MS = 30000;

class MeshDiscovery extends EventEmitter {
  constructor(config = {}) {
    super();
    this.identity = config.identity;
    this.port = config.port;
    this.enabled = config.enabled !== false;

    this.bonjour = null;
    this.browser = null;
    this.service = null;
    this.discovered = new Map();
    this.running = false;
  }

  async start() {
    if (!this.enabled) return;

    try {
      const Bonjour = require('bonjour-service');
      this.bonjour = new Bonjour.default();
    } catch {
      console.log('[mesh-discovery] bonjour-service not available, mDNS discovery disabled');
      console.log('[mesh-discovery] install with: npm install bonjour-service');
      return;
    }

    this.running = true;
    this._advertise();
    this._browse();
  }

  async stop() {
    this.running = false;

    if (this.service) {
      try { this.service.stop(); } catch { /* ignore */ }
      this.service = null;
    }

    if (this.browser) {
      try { this.browser.stop(); } catch { /* ignore */ }
      this.browser = null;
    }

    if (this.bonjour) {
      try { this.bonjour.destroy(); } catch { /* ignore */ }
      this.bonjour = null;
    }

    this.discovered.clear();
  }

  _advertise() {
    if (!this.bonjour) return;

    this.service = this.bonjour.publish({
      name: `king-louie-${this.identity.peerId}`,
      type: SERVICE_TYPE,
      protocol: SERVICE_PROTOCOL,
      port: this.port,
      txt: {
        peerId: this.identity.peerId,
        displayName: this.identity.displayName || '',
        capabilities: (this.identity.capabilities || []).join(','),
        fingerprint: this.identity.publicKey.toString('hex').slice(0, 16)
      }
    });

    console.log(`[mesh-discovery] advertising as ${this.identity.peerId} on port ${this.port}`);
  }

  _browse() {
    if (!this.bonjour) return;

    this.browser = this.bonjour.find({ type: SERVICE_TYPE, protocol: SERVICE_PROTOCOL });

    this.browser.on('up', (service) => {
      const txt = service.txt || {};
      const peerId = txt.peerId;

      if (!peerId || peerId === this.identity.peerId) return;

      const addresses = service.addresses || [];
      const address = addresses.find((a) => !a.includes(':')) || addresses[0];

      if (!address) return;

      const peerInfo = {
        peerId,
        displayName: txt.displayName || '',
        capabilities: txt.capabilities ? txt.capabilities.split(',').filter(Boolean) : [],
        fingerprint: txt.fingerprint || '',
        address,
        port: service.port,
        discoveredAt: Date.now()
      };

      const existing = this.discovered.get(peerId);
      this.discovered.set(peerId, peerInfo);

      if (!existing) {
        console.log(`[mesh-discovery] found peer: ${peerId} (${peerInfo.displayName || 'unnamed'}) at ${address}:${service.port}`);
        this.emit('peerDiscovered', peerInfo);
      } else {
        this.emit('peerUpdated', peerInfo);
      }
    });

    this.browser.on('down', (service) => {
      const txt = service.txt || {};
      const peerId = txt.peerId;

      if (!peerId || peerId === this.identity.peerId) return;

      const peerInfo = this.discovered.get(peerId);
      if (peerInfo) {
        this.discovered.delete(peerId);
        console.log(`[mesh-discovery] peer lost: ${peerId}`);
        this.emit('peerLost', peerInfo);
      }
    });
  }

  getDiscoveredPeers() {
    return Array.from(this.discovered.values());
  }

  isAvailable() {
    return this.bonjour !== null;
  }
}

module.exports = { MeshDiscovery };
