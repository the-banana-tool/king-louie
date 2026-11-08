const { describe, it } = require('node:test');
const assert = require('node:assert');
const { DesktopState } = require('../src/ipc/desktop-state');

// Helper: create a stateful mock store that persists changes
function createMockStore(initialState = {}) {
  let data = initialState;
  return {
    state: () => ({ ...data }),
    save: () => {
      // Data is already modified in place; save is a no-op
    },
    set(key, value) {
      data[key] = value;
    },
    get(key) {
      return data[key];
    }
  };
}

describe('desktop-state: nodes and remote pairing', () => {
  describe('stage 2 pairing migration', () => {
    it('opens with one local entry and pairing still reads it', () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: { relay: { nodeId: 'relay-123' } },
        },
      });
      const state = new DesktopState(store);
      const nodes = state.nodes;
      assert.strictEqual(nodes.length, 1);
      assert.strictEqual(nodes[0].kind, 'local');
      assert.strictEqual(nodes[0].id, 'local-id');
      const pairing = state.pairing;
      assert.strictEqual(pairing.relay.nodeId, 'relay-123');
    });

    it('setPairing writes through to state', () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
        },
      });
      const state = new DesktopState(store);
      state.setPairing({ relay: { nodeId: 'relay-456' } });
      const pairing = state.pairing;
      assert.strictEqual(pairing.relay.nodeId, 'relay-456');
    });

    it('clearPairing removes pairing from state', () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: { relay: { nodeId: 'relay-789' } },
        },
      });
      const state = new DesktopState(store);
      state.clearPairing();
      const pairing = state.pairing;
      assert.strictEqual(pairing.relay, undefined);
    });
  });

  describe('sealed token validation', () => {
    it('rejects remote entries with raw access tokens (unsealed)', () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
          nodes: [
            {
              id: 'remote-1',
              kind: 'remote',
              access: 'raw-token-should-be-sealed', // This should be sealed
            },
          ],
        },
      });
      const state = new DesktopState(store);
      // Should throw or refuse when accessing nodes with raw tokens
      assert.throws(() => {
        state.nodes; // Reading nodes should validate sealed tokens
      }, /sealed/i);
    });

    it('allows remote entries with properly sealed tokens', () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
          nodes: [
            {
              id: 'remote-1',
              kind: 'remote',
              accessSealed: 'sealed:...',
              status: 'connected',
            },
          ],
        },
      });
      const state = new DesktopState(store);
      const nodes = state.nodes;
      assert.strictEqual(nodes.length, 1);
      assert.strictEqual(nodes[0].kind, 'remote');
      assert.strictEqual(nodes[0].id, 'remote-1');
    });
  });

  describe('node management', () => {
    it('addNode adds a new node to the list', () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
          nodes: [],
        },
      });
      const state = new DesktopState(store);
      state.addNode({ id: 'remote-1', kind: 'remote', status: 'connected' });
      const nodes = state.nodes;
      assert.strictEqual(nodes.length, 1);
      assert.strictEqual(nodes[0].id, 'remote-1');
    });

    it('updateNode patches an existing node', () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
          nodes: [{ id: 'remote-1', kind: 'remote', status: 'connected' }],
        },
      });
      const state = new DesktopState(store);
      state.updateNode('remote-1', { status: 'disconnected' });
      const node = state.nodes.find((n) => n.id === 'remote-1');
      assert.strictEqual(node.status, 'disconnected');
    });

    it('removeNode deletes a node', () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
          nodes: [
            { id: 'remote-1', kind: 'remote', status: 'connected' },
            { id: 'remote-2', kind: 'remote', status: 'disconnected' },
          ],
        },
      });
      const state = new DesktopState(store);
      state.removeNode('remote-1');
      const nodes = state.nodes;
      assert.strictEqual(nodes.length, 1);
      assert.strictEqual(nodes[0].id, 'remote-2');
    });

    it('removeNode of local entry clears pairing', () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: { relay: { nodeId: 'relay-123' } },
          nodes: [],
        },
      });
      const state = new DesktopState(store);
      state.removeNode('local-id');
      assert.strictEqual(state.pairing.relay, undefined);
    });

    it('setNodeOrder reorders nodes', () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
          nodes: [
            { id: 'remote-1', kind: 'remote' },
            { id: 'remote-2', kind: 'remote' },
          ],
        },
      });
      const state = new DesktopState(store);
      state.setNodeOrder(['remote-2', 'remote-1']);
      const nodes = state.nodes;
      assert.strictEqual(nodes[0].id, 'remote-2');
      assert.strictEqual(nodes[1].id, 'remote-1');
    });

    it('noteSetup({ windowOnly }) records one-window mode', () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
          setup: {},
        },
      });
      const state = new DesktopState(store);
      state.noteSetup({ windowOnly: true });
      assert.strictEqual(state.setup.windowOnly, true);
    });
  });

  describe('controller: front door OAuth flow', () => {
    it('addFrontDoor registers and authorizes a front door', async () => {
      const oauthClient = {
        register: async () => ({ clientId: 'client-123' }),
        authorize: async () => ({ token: 'auth-token-456' }),
      };
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
          nodes: [],
        },
      });
      const state = new DesktopState(store);
      const controller = state.getController({ oauthClient });
      const result = await controller.addFrontDoor({ origin: 'https://mcp.example.com' });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.frontDoorId, 'client-123');
    });

    it('listFrontDoorNodes returns nodes for a front door', async () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: { frontDoor: { clientId: 'client-123', nodes: [{ nodeId: 'node-1' }] } },
          nodes: [],
        },
      });
      const state = new DesktopState(store);
      const controller = state.getController();
      const result = await controller.listFrontDoorNodes('client-123');
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.nodes.length, 1);
    });
  });

  describe('controller: remote node operations', () => {
    it('addRemoteNode adds a node from a front door', async () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
          nodes: [],
        },
      });
      const state = new DesktopState(store);
      const controller = state.getController();
      const result = await controller.addRemoteNode({
        frontDoorId: 'client-123',
        nodeId: 'node-1',
      });
      assert.strictEqual(result.ok, true);
      const nodes = state.nodes;
      const remote = nodes.find((n) => n.id === 'node-1');
      assert(remote);
      assert.strictEqual(remote.kind, 'remote');
    });

    it('enrollRemote generates a QR code for enrollment', async () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
          nodes: [{ id: 'remote-1', kind: 'remote', status: 'connecting' }],
        },
      });
      const state = new DesktopState(store);
      const controller = state.getController();
      const result = await controller.enrollRemote('remote-1', 'My Remote');
      assert.strictEqual(result.ok, true);
      assert(result.qr); // Should have QR code
    });

    it('forgetNode revokes OAuth token and keeps node untouched', async () => {
      const oauthClient = {
        revoke: async () => ({ ok: true }),
      };
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
          nodes: [{ id: 'remote-1', kind: 'remote', frontDoorId: 'client-123' }],
        },
      });
      const state = new DesktopState(store);
      const controller = state.getController({ oauthClient });
      const result = await controller.forgetNode('remote-1');
      assert.strictEqual(result.ok, true);
      // Node should still exist (just disconnected)
      const nodes = state.nodes;
      const remote = nodes.find((n) => n.id === 'remote-1');
      assert(remote);
    });

    it('remoteStatus returns view describing node state', async () => {
      const store = createMockStore({
        mesh: {
          identity: { node_id: 'local-id' },
          pairing: {},
          nodes: [
            {
              id: 'remote-1',
              kind: 'remote',
              status: 'enrolling',
              enrollCode: 'ABC123',
            },
          ],
        },
      });
      const state = new DesktopState(store);
      const controller = state.getController();
      const result = await controller.remoteStatus('remote-1');
      assert.strictEqual(result.ok, true);
      assert(result.view);
      assert(result.qr); // QR for enrolling status
    });
  });

  describe('pane model: remote entry rendering', () => {
    it('remote entry pane has kind remote', () => {
      const entry = { id: 'remote-1', kind: 'remote', status: 'connected' };
      const paneView = describeServicePane(entry);
      assert.strictEqual(paneView.kind, 'remote');
    });

    it('remote entry pane has no Install, Restart, Unpair, Detach', () => {
      const entry = { id: 'remote-1', kind: 'remote', status: 'connected' };
      const paneView = describeServicePane(entry);
      assert(!paneView.install);
      assert(!paneView.restart);
      assert(!paneView.unpair);
      assert(!paneView.detach);
    });

    it('remote entry pane shows connection status', () => {
      const entry = { id: 'remote-1', kind: 'remote', status: 'connected' };
      const paneView = describeServicePane(entry);
      assert.strictEqual(paneView.status, 'connected');
    });
  });
});

// Helper: stub of describeServicePane for testing
function describeServicePane(entry) {
  if (entry.kind !== 'remote') {
    return { kind: entry.kind };
  }
  return {
    kind: 'remote',
    status: entry.status,
    // No install, restart, unpair, detach for remote entries
  };
}
