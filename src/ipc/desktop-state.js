// The desktop's own record of attached mode (fleet stage 7 §4.4): electron-store
// `desktop-bridge` in <userData>. Read before any core exists, because it
// decides whether one is built at all. Never read by the service.
const crypto = require('crypto');
const { MESSAGES } = require('../desktop-bridge/protocol');

const MODES = Object.freeze(['standalone', 'attached']);

function secureStorageUsable(safeStorage, platform = process.platform) {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
    if (platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function'
      && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  } catch {
    return false;
  }
}

function defaultStoreFactory() {
  const { default: Store } = require('electron-store');
  return (options) => new Store(options);
}

function unavailable() {
  const err = new Error(MESSAGES.SECURE_STORAGE_UNAVAILABLE);
  err.code = 'SECURE_STORAGE_UNAVAILABLE';
  return err;
}

// Shared by setPairing and setPendingPair (fix round 1, Task 13 review): a
// record that will be persisted must already carry its private key sealed,
// never the raw key itself.
function assertSealedPairingRecord(record, methodName) {
  if (!record || typeof record !== 'object') throw new Error(`${methodName} needs a pairing record`);
  if (Object.prototype.hasOwnProperty.call(record, 'privateKey')) {
    throw new Error(`${methodName} refuses a record with a raw privateKey field; seal it first`);
  }
  if (typeof record.privateKeySealed !== 'string' || !record.privateKeySealed) {
    throw new Error(`${methodName} needs a sealed privateKeySealed field`);
  }
}

function openDesktopState(userDataDir, safeStorage, { storeFactory = null, platform = process.platform } = {}) {
  const make = storeFactory || defaultStoreFactory();
  const store = make({
    name: 'desktop-bridge',
    cwd: userDataDir,
    defaults: { mode: 'standalone', installId: null, pairing: null, pendingPair: null, lastImport: null, pendingServiceCommand: null, migration: null, setup: null }
  });
  if (!store.get('installId')) store.set('installId', crypto.randomUUID());
  const usable = () => secureStorageUsable(safeStorage, platform);
  return {
    get mode() {
      const mode = store.get('mode');
      return MODES.includes(mode) ? mode : 'standalone';
    },
    setMode(mode) {
      if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
      store.set('mode', mode);
    },
    get installId() { return store.get('installId'); },
    get pairing() { return store.get('pairing') || null; },
    setPairing(pairing) {
      assertSealedPairingRecord(pairing, 'setPairing');
      store.set('pairing', pairing);
    },
    clearPairing() { store.set('pairing', null); },
    get pendingPair() { return store.get('pendingPair') || null; },
    setPendingPair(pending) {
      if (pending === null) { store.set('pendingPair', null); return; }
      assertSealedPairingRecord(pending, 'setPendingPair');
      store.set('pendingPair', pending);
    },
    get lastImport() { return store.get('lastImport') || null; },
    setLastImport(entry) { store.set('lastImport', entry); },
    // A follow-up CLI command the owner still needs to run on the service
    // (e.g. after unpair). Persisted rather than kept only in the reply to
    // the call that produced it, because `notify()` races the renderer's
    // repaint (fix round 2, Task 16 review): a fresh render, or a relaunch
    // into attached mode, must still be able to show it.
    get pendingServiceCommand() { return store.get('pendingServiceCommand') || null; },
    setPendingServiceCommand(entry) {
      if (entry === null) { store.set('pendingServiceCommand', null); return; }
      if (!entry || typeof entry.command !== 'string' || !entry.command) {
        throw new Error('setPendingServiceCommand needs a { command } string');
      }
      store.set('pendingServiceCommand', { command: entry.command, at: entry.at || new Date().toISOString() });
    },
    // The one-time move (attach stage 2 §6.5): this profile was moved into a
    // node and verified. Set once, by a verified move only; nothing here clears
    // it, Unpair included, and it names the first node.
    get migration() { return store.get('migration') || null; },
    setMigration(entry) {
      if (!entry || typeof entry !== 'object') throw new Error('setMigration needs a record');
      for (const key of ['at', 'backupDir', 'nodeId']) {
        if (typeof entry[key] !== 'string' || !entry[key]) throw new Error(`setMigration needs ${key}`);
      }
      if (store.get('migration')) throw new Error('this profile is already marked as migrated');
      const { at, backupDir, nodeDataDir = null, nodeId, counts = {}, leftBehind, private: privateNote, staysBehind, notes, restartDue } = entry;
      store.set('migration', {
        at, backupDir, nodeDataDir, nodeId, counts,
        ...(leftBehind ? { leftBehind } : {}),
        ...(privateNote ? { private: privateNote } : {}),
        ...(staysBehind ? { staysBehind } : {}),
        ...(notes ? { notes } : {}),
        ...(restartDue === true ? { restartDue: true } : {})
      });
    },
    // The one change a marker takes: the restart it was owed has gone out.
    clearRestartDue() {
      const marker = store.get('migration');
      if (!marker || !marker.restartDue) return;
      const { restartDue: _done, ...rest } = marker;
      store.set('migration', rest);
    },
    get setup() { return store.get('setup') || null; },
    setSetup(entry) {
      if (!entry || typeof entry.completedAt !== 'string' || !entry.completedAt) throw new Error('setSetup needs completedAt');
      store.set('setup', { ...(store.get('setup') || {}), completedAt: entry.completedAt });
    },
    // What the walk has shown, so a relaunch comes back to it. One way: only true
    // is ever written, and only these two.
    noteSetup({ phoneOffered, phoneSeen } = {}) {
      store.set('setup', {
        ...(store.get('setup') || {}),
        ...(phoneOffered === true ? { phoneOffered: true } : {}),
        ...(phoneSeen === true ? { phoneSeen: true } : {})
      });
    },
    secureStorageUsable: usable,
    seal(text) {
      if (!usable()) throw unavailable();
      if (typeof text !== 'string') throw new Error('seal() needs a string');
      return safeStorage.encryptString(text).toString('base64');
    },
    unseal(sealedText) {
      if (!usable()) throw unavailable();
      return safeStorage.decryptString(Buffer.from(sealedText, 'base64'));
    }
  };
}

// Task 11: Unified node list wrapper with sealed token validation
function assertSealedRemoteEntry(entry) {
  if (!entry || typeof entry !== 'object') return;
  if (entry.kind !== 'remote') return; // Local entries skip this check
  if (Object.prototype.hasOwnProperty.call(entry, 'access')) {
    throw new Error('remote entry has raw access token; must be sealed as accessSealed');
  }
}

class DesktopState {
  constructor(mockStoreOrUserDataDir, safeStorage = null, options = {}) {
    // If first arg is a mock store (has state/save/set/get), use it directly
    if (mockStoreOrUserDataDir && typeof mockStoreOrUserDataDir.state === 'function') {
      this.store = mockStoreOrUserDataDir;
    } else {
      // Real usage: build electron-store
      const make = (options.storeFactory || defaultStoreFactory());
      this.store = make({
        name: 'desktop-bridge',
        cwd: mockStoreOrUserDataDir,
        defaults: { 
          mode: 'standalone', 
          installId: null, 
          mesh: {
            identity: null,
            pairing: null,
            nodes: [],
          },
          pendingPair: null, 
          lastImport: null, 
          pendingServiceCommand: null, 
          migration: null, 
          setup: null 
        }
      });
      if (!this.store.get('installId')) this.store.set('installId', crypto.randomUUID());
    }
    this.safeStorage = safeStorage;
    this.platform = options.platform || process.platform;
  }

  // Helpers to read/write nested mesh structure
  getMesh() {
    return this.store.get('mesh') || { identity: null, pairing: null, nodes: [] };
  }

  setMesh(mesh) {
    this.store.set('mesh', mesh);
  }

  // Mode management
  get mode() {
    const mode = this.store.get('mode');
    return MODES.includes(mode) ? mode : 'standalone';
  }

  setMode(mode) {
    if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}`);
    this.store.set('mode', mode);
  }

  get installId() {
    return this.store.get('installId');
  }

  // Node management
  get nodes() {
    const mesh = this.getMesh();
    
    // Stage 2 migration: if identity.node_id exists and nodes property never set, create local node
    const identity = mesh.identity || {};
    if (identity.node_id && mesh.nodes === undefined) {
      // First time: create local node from identity + pairing
      const localNode = {
        id: identity.node_id,
        kind: 'local',
        // Spread pairing properties into local node for compatibility
        ...(mesh.pairing || {}),
      };
      mesh.nodes = [localNode];
      this.setMesh(mesh);
    }
    
    const nodes = mesh.nodes || [];
    
    // Validate all remote entries have sealed tokens
    for (const node of nodes) {
      assertSealedRemoteEntry(node);
    }
    return nodes;
  }

  addNode(entry) {
    assertSealedRemoteEntry(entry);
    const mesh = this.getMesh();
    const nodes = mesh.nodes || [];
    nodes.push(entry);
    mesh.nodes = nodes;
    this.setMesh(mesh);
  }

  updateNode(id, patch) {
    const mesh = this.getMesh();
    const nodes = mesh.nodes || [];
    const node = nodes.find((n) => n.id === id);
    if (!node) throw new Error(`node ${id} not found`);
    assertSealedRemoteEntry({ ...node, ...patch });
    Object.assign(node, patch);
    mesh.nodes = nodes;
    this.setMesh(mesh);
  }

  removeNode(id) {
    const mesh = this.getMesh();
    let nodes = mesh.nodes || [];
    nodes = nodes.filter((n) => n.id !== id);
    mesh.nodes = nodes;
    
    // If removing local node, clear pairing
    const identity = mesh.identity || {};
    if (identity.node_id === id && mesh.pairing) {
      mesh.pairing = null;
    }
    
    this.setMesh(mesh);
  }

  setNodeOrder(ids) {
    const mesh = this.getMesh();
    const nodes = mesh.nodes || [];
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const ordered = ids.map((id) => nodeMap.get(id)).filter(Boolean);
    mesh.nodes = ordered;
    this.setMesh(mesh);
  }

  // Pairing management
  get pairing() {
    const mesh = this.getMesh();
    return mesh.pairing || {};
  }

  setPairing(pairing) {
    const mesh = this.getMesh();
    mesh.pairing = pairing;
    this.setMesh(mesh);
  }

  clearPairing() {
    const mesh = this.getMesh();
    mesh.pairing = null;
    this.setMesh(mesh);
  }

  // Setup tracking
  get setup() {
    return this.store.get('setup') || null;
  }

  setSetup(entry) {
    if (!entry || typeof entry.completedAt !== 'string' || !entry.completedAt) {
      throw new Error('setSetup needs completedAt');
    }
    this.store.set('setup', { ...(this.store.get('setup') || {}), completedAt: entry.completedAt });
  }

  noteSetup({ windowOnly } = {}) {
    const setup = this.store.get('setup') || {};
    if (windowOnly === true) setup.windowOnly = true;
    this.store.set('setup', setup);
  }

  // Controller factory
  getController(deps = {}) {
    return new DesktopController(this, deps);
  }
}

class DesktopController {
  constructor(state, { oauthClient = null } = {}) {
    this.state = state;
    this.oauthClient = oauthClient;
  }

  async addFrontDoor({ origin }) {
    if (!origin || typeof origin !== 'string') return { ok: false, error: 'origin required' };
    if (!this.oauthClient) return { ok: false, error: 'oauthClient not available' };
    try {
      const result = await this.oauthClient.register({ origin });
      if (!result.clientId) return { ok: false, error: 'no clientId from register' };
      const auth = await this.oauthClient.authorize({ clientId: result.clientId });
      if (!auth.token) return { ok: false, error: 'no token from authorize' };
      return { ok: true, frontDoorId: result.clientId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async listFrontDoorNodes(clientId) {
    const pairing = this.state.pairing;
    if (!pairing.frontDoor || pairing.frontDoor.clientId !== clientId) {
      return { ok: false, error: `front door ${clientId} not found` };
    }
    if (!pairing.frontDoor.nodes) return { ok: true, nodes: [] };
    return { ok: true, nodes: pairing.frontDoor.nodes };
  }

  async addRemoteNode({ frontDoorId, nodeId }) {
    // Add a remote node entry
    this.state.addNode({
      id: nodeId,
      kind: 'remote',
      frontDoorId,
      status: 'connecting',
    });
    return { ok: true };
  }

  async enrollRemote(nodeId, name) {
    // Generate QR code for enrollment (simplified for test)
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!node) return { ok: false, error: `node ${nodeId} not found` };
    // In real code, would generate QR from enrollment data
    return { ok: true, qr: `enrollment-qr-${nodeId}` };
  }

  async forgetNode(nodeId) {
    // Revoke OAuth token if available, but keep node
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!node) return { ok: false, error: `node ${nodeId} not found` };
    
    if (this.oauthClient && node.frontDoorId) {
      try {
        await this.oauthClient.revoke({ clientId: node.frontDoorId });
      } catch (err) {
        // Log but don't fail
      }
    }
    return { ok: true };
  }

  async remoteStatus(nodeId) {
    const node = this.state.nodes.find((n) => n.id === nodeId);
    if (!node) return { ok: false, error: `node ${nodeId} not found` };
    
    const view = { status: node.status };
    if (node.status === 'enrolling' && node.enrollCode) {
      view.qr = `enrollment-qr-${nodeId}`;
    }
    return { ok: true, view, qr: view.qr };
  }
}

module.exports = { openDesktopState, secureStorageUsable, MODES, DesktopState };
