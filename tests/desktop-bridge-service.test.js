// tests/desktop-bridge-service.test.js
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadServiceConfig, DEFAULT_PORTS, DEFAULT_FEATURES } = require('../src/service/config');
const { createDesktopBridgeHost } = require('../src/desktop-bridge/service-wiring');
const { DesktopBridgeClient } = require('../src/desktop-bridge/bridge-client');
const { buildServicePorts } = require('../src/service/ports');
const { createCore } = require('../src/core');
const { CHAT_DATA_DEFAULTS } = require('../src/core/settings');
const { loadProfile } = require('../src/service/run');
const keys = require('../src/desktop-bridge/keys');
const pairing = require('../src/desktop-bridge/pairing');

const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function layout(adminCfg = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-bridge-svc-'));
  dirs.push(root);
  const dataDir = path.join(root, 'data');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  fs.mkdirSync(configDir, { mode: 0o755 });
  if (adminCfg) {
    const file = path.join(configDir, 'service.json');
    fs.writeFileSync(file, JSON.stringify(adminCfg), { mode: 0o644 });
    if (process.platform !== 'win32') fs.chmodSync(file, 0o644);
  }
  return { dataDir, configDir };
}
const opts = (configDir) => ({ adminConfigDir: configDir, geteuid: () => -1, adminUid: selfUid });
const waitFor = async (fn, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
};

describe('service config', () => {
  it('adds desktopBridge off by default on port 18796', () => {
    assert.strictEqual(DEFAULT_FEATURES.desktopBridge, false);
    assert.strictEqual(DEFAULT_PORTS.desktopBridge, 18796);
    // 18795 is the relay mesh listener's default (fleet stage 3); the two
    // defaults must never collide, and the server's own default must agree.
    assert.notStrictEqual(DEFAULT_PORTS.desktopBridge, 18795);
    assert.strictEqual(require('../src/desktop-bridge/protocol').DEFAULT_DESKTOP_BRIDGE_PORT, DEFAULT_PORTS.desktopBridge);
    const { dataDir, configDir } = layout();
    const cfg = loadServiceConfig(dataDir, {}, opts(configDir));
    assert.strictEqual(cfg.features.desktopBridge, false);
    assert.strictEqual(cfg.ports.desktopBridge, 18796);
  });

  it('accepts an ephemeral desktop bridge port but no other zero port', () => {
    let l = layout({ features: { desktopBridge: true }, ports: { desktopBridge: 0 } });
    assert.strictEqual(loadServiceConfig(l.dataDir, {}, opts(l.configDir)).ports.desktopBridge, 0);
    l = layout({ ports: { gateway: 0 } });
    assert.throws(() => loadServiceConfig(l.dataDir, {}, opts(l.configDir)), /ports\.gateway must be an integer from 1 to 65535/);
  });

  it('refuses the feature on profile: runbook', () => {
    const l = layout({ profile: 'runbook', features: { desktopBridge: true } });
    assert.throws(() => loadServiceConfig(l.dataDir, {}, opts(l.configDir)), /desktopBridge needs profile: agent/);
  });
});

describe('createDesktopBridgeHost', () => {
  it('is inert with the feature off', async () => {
    const { dataDir } = layout();
    const host = createDesktopBridgeHost({ dataDir, features: { desktopBridge: false }, ports: { desktopBridge: 0 } });
    assert.deepStrictEqual(host.coreDeps, {});
    assert.strictEqual(await host.start({}), null);
    await host.stop();
  });

  it('binds, serves a paired desktop, forwards ambient events and reports interactive', async () => {
    const { dataDir, configDir } = layout();
    const host = createDesktopBridgeHost({ dataDir, configDir, features: { desktopBridge: true }, ports: { desktopBridge: 0 }, adminUid: selfUid, version: '26.9.0' });
    assert.strictEqual(host.coreDeps.host.interactive(), false);
    const servicePorts = buildServicePorts({ dataDir, chatDataDefaults: CHAT_DATA_DEFAULTS });
    const core = createCore({
      ...servicePorts,
      ...host.coreDeps,
      features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false },
      remoteApprovals: 'deny',
      workingDirectory: dataDir,
      builtinSkillsDir: path.join(__dirname, '..', 'skills')
    });
    await core.start();
    try {
      const server = await host.start({ core, ports: servicePorts, approvals: null });
      assert.ok(server.port > 0);
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      const raw = keys.rawFromPublicKeyObject(publicKey);
      const deviceId = keys.deriveDeviceId(raw, 'kld-');
      pairing.writeFileAtomic(path.join(configDir, 'desktop-devices.json'), JSON.stringify(pairing.upsertDevice(pairing.emptyDevices(), { deviceId, publicKey: keys.toB64url(raw), label: 'web-01 desk', pairedAt: '2026-09-23T14:02:11Z' })), 0o644);
      const client = new DesktopBridgeClient({
        port: server.port,
        pin: { nodeId: server.identity.nodeId, publicKey: server.identity.publicKey.toString('hex') },
        deviceId,
        sign: async (bytes) => crypto.sign(null, bytes, privateKey)
      });
      const service = await client.connect();
      assert.strictEqual(service.profile, 'agent');
      assert.ok(service.channels.includes('chat:load'));
      assert.strictEqual(host.coreDeps.host.interactive(), true);
      const events = [];
      client.on('event', (channel) => events.push(channel));
      host.coreDeps.ui.send('chat:updated', { chats: [] });
      host.coreDeps.ui.send('tool:approvalRequired', { approvalId: 'x' });
      const loaded = await client.invoke('chat:load', []);
      assert.strictEqual(loaded.ok, true);
      assert.deepStrictEqual(events, ['chat:updated']);
      const states = [];
      client.on('state', (s) => states.push(s.status));
      await host.stop();
      await waitFor(() => states.length > 0);
      assert.strictEqual(host.coreDeps.host.interactive(), false);
      client.close();
    } finally {
      await host.stop();
      await core.shutdown();
    }
  });
});

describe('loadProfile("agent") with the desktop bridge', () => {
  it('starts the bridge after the core and stops it first', async () => {
    // configDir is injected so this never falls through to the real
    // per-platform admin config dir (e.g. /etc/king-louie) that
    // loadNodeConfig would otherwise default to.
    const { dataDir, configDir } = layout();

    // Order spy: wrap createCore's and createDesktopBridgeHost's returned
    // objects (via the cached modules run.js itself requires) rather than
    // changing production code, to prove stop() really calls the bridge's
    // stop before the core's shutdown — not just that both eventually run.
    const coreModule = require('../src/core');
    const wiring = require('../src/desktop-bridge/service-wiring');
    const originalCreateCore = coreModule.createCore;
    const originalCreateHost = wiring.createDesktopBridgeHost;
    const order = [];
    coreModule.createCore = (createOpts) => {
      const core = originalCreateCore(createOpts);
      const originalShutdown = core.shutdown;
      core.shutdown = async (...args) => { order.push('core'); return originalShutdown(...args); };
      return core;
    };
    wiring.createDesktopBridgeHost = (hostOpts) => {
      const host = originalCreateHost(hostOpts);
      const originalStop = host.stop;
      host.stop = async (...args) => { order.push('bridge'); return originalStop(...args); };
      return host;
    };
    try {
      const running = await loadProfile('agent').start({
        dataDir,
        configDir,
        features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: true },
        ports: { gateway: 18793, webhook: 18794, desktopBridge: 0 },
        workspace: dataDir,
        adminUid: selfUid
      });
      try {
        assert.ok(running.desktopBridge.server.port > 0);
      } finally {
        await running.stop();
      }
      assert.strictEqual(running.desktopBridge.server, null);
      assert.deepStrictEqual(order, ['bridge', 'core']);
    } finally {
      coreModule.createCore = originalCreateCore;
      wiring.createDesktopBridgeHost = originalCreateHost;
    }
  });
});
