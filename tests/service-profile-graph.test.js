const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FORBIDDEN = ['src/providers/', 'src/execution/agent-loop', 'src/tools/', 'src/browser/', 'src/channels/', 'src/mcp/', 'src/core/create-core', 'src/execution/safety-policy',
  'src/mesh/mesh-discovery', 'src/mesh/mesh-swarm', 'src/mesh/mesh-remote-control', 'src/mesh/mesh-channel'];

describe('runbook profile module graph', () => {
  it('never loads the agent stack, even after actually starting and stopping', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-runbook-graph-'));
    try {
      // Starting the profile (not just loading it) is what pulls in the
      // modules its start() path requires lazily — ports, key resolution,
      // stores — so the snapshot is taken after start() and stop().
      const script = `
        const { loadProfile } = require('./src/service/run');
        (async () => {
          const running = await loadProfile('runbook').start({ dataDir: process.env.KL_GRAPH_DATA_DIR });
          await running.stop();
          process.stdout.write(JSON.stringify(Object.keys(require.cache)));
        })().catch((err) => { process.stderr.write(String(err && err.stack || err)); process.exit(1); });
      `;
      const out = execFileSync(process.execPath, ['-e', script], {
        cwd: ROOT,
        env: { ...process.env, KL_GRAPH_DATA_DIR: dataDir, KING_LOUIE_LOG_LEVEL: 'silent' }
      }).toString();
      const loaded = JSON.parse(out).map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
      assert.ok(loaded.includes('src/service/ports.js'), 'start() must have run (ports.js is only required inside it)');
      assert.ok(loaded.includes('src/approvals/service-wiring.js'), 'the runbook profile starts phone approvals');
      assert.ok(loaded.includes('src/fleet/start.js'), 'the runbook profile hosts the fleet node (§3.7)');
      assert.ok(loaded.includes('src/fleet/fleet-tools.js'));
      assert.ok(!loaded.includes('src/fleet/delegate-sessions.js'), 'delegate sessions are agent-only');
      assert.ok(fs.existsSync(path.join(dataDir, 'key-check')), 'start() resolved the master key');
      const bad = loaded.filter((p) => FORBIDDEN.some((f) => p.startsWith(f)));
      assert.deepStrictEqual(bad, []);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('relay module graph', () => {
  it('starting and stopping the relay loads no agent code', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-relay-graph-'));
    try {
      const script = `
        const { startRelay } = require('./src/frontdoor/relay');
        const { NodeIdentity } = require('./src/mesh/node-identity');
        (async () => {
          const relay = await startRelay({
            dataDir: process.env.KL_GRAPH_DATA_DIR,
            identity: new NodeIdentity({ nodeName: 'relay' }),
            useTls: false,
            config: { phoneListen: { host: '127.0.0.1', port: 0 }, meshListen: { host: '127.0.0.1', port: 0 }, publicUrl: 'https://kl.example.com', tls: {}, push: {} }
          });
          await relay.stop();
          process.stdout.write(JSON.stringify(Object.keys(require.cache)));
        })().catch((err) => { process.stderr.write(String(err && err.stack || err)); process.exit(1); });
      `;
      const out = execFileSync(process.execPath, ['-e', script], {
        cwd: ROOT,
        env: { ...process.env, KL_GRAPH_DATA_DIR: dataDir, KING_LOUIE_LOG_LEVEL: 'silent' }
      }).toString();
      const loaded = JSON.parse(out).map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
      assert.ok(loaded.includes('src/frontdoor/relay.js'));
      const bad = loaded.filter((p) => FORBIDDEN.some((f) => p.startsWith(f)) || p.startsWith('src/core/'));
      assert.deepStrictEqual(bad, []);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('frontdoor module graph', () => {
  it('starting and stopping the frontdoor profile loads no agent, runbook or mesh-discovery code (§3.1)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-frontdoor-graph-'));
    try {
      const script = `
        const fs = require('fs');
        const path = require('path');
        const { loadProfile } = require('./src/service/run');
        const { createCa, issueCert } = require('./tests/helpers/test-certs');
        (async () => {
          const base = process.env.KL_GRAPH_BASE;
          const configDir = path.join(base, 'config');
          const dataDir = path.join(base, 'data');
          fs.mkdirSync(path.join(configDir, 'approvers'), { recursive: true, mode: 0o755 });
          fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
          const leaf = issueCert(createCa(), { dnsNames: ['mcp.kl.example.com'] });
          fs.writeFileSync(path.join(configDir, 'mcp.pem'), leaf.cert, { mode: 0o644 });
          fs.writeFileSync(path.join(configDir, 'mcp.key'), leaf.key, { mode: 0o600 });
          fs.writeFileSync(path.join(configDir, 'node.yaml'), [
            'name: frontdoor', 'profile: frontdoor', 'frontdoor:', '  domain: kl.example.com',
            '  tls: { cert_file: ' + JSON.stringify(path.join(configDir, 'mcp.pem')) + ', key_file: ' + JSON.stringify(path.join(configDir, 'mcp.key')) + ' }', ''
          ].join('\\n'), { mode: 0o644 });
          const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
          const serviceConfig = { profile: 'frontdoor', features: { gateway: false, webhooks: false, mesh: false, channels: false, appDiscovery: false, desktopBridge: false }, ports: {}, relayRaw: null, audit: { retentionDays: 365 } };
          const running = await loadProfile('frontdoor').start({ dataDir, configDir, adminUid: uid, serviceConfig, deps: { listen: { host: '127.0.0.1', port: 0 } } });
          await running.stop();
          process.stdout.write(JSON.stringify(Object.keys(require.cache)));
        })().catch((err) => { process.stderr.write(String(err && err.stack || err)); process.exit(1); });
      `;
      const out = execFileSync(process.execPath, ['-e', script], {
        cwd: ROOT,
        env: { ...process.env, KL_GRAPH_BASE: base, KING_LOUIE_LOG_LEVEL: 'silent' }
      }).toString();
      const loaded = JSON.parse(out).map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
      assert.ok(loaded.includes('src/frontdoor/profile.js'));
      const FRONTDOOR_FORBIDDEN = ['src/core/', 'src/providers/', 'src/execution/', 'src/tools/', 'src/runbooks/', 'src/browser/', 'src/channels/', 'src/mcp/',
        'src/mesh/mesh-discovery', 'src/mesh/mesh-remote-control', 'src/mesh/mesh-swarm'];
      const bad = loaded.filter((p) => FRONTDOOR_FORBIDDEN.some((f) => p.startsWith(f)));
      assert.deepStrictEqual(bad, []);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('mcp module graph', () => {
  it('mcp (no service running) never loads the agent core, on any profile', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mcp-graph-'));
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      const script = `
        const { PassThrough } = require('stream');
        const { runMcp } = require('./src/service/commands/mcp');
        runMcp({ dataDir: process.env.KL_GRAPH_DATA_DIR, io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() } })
          .catch((err) => { process.stderr.write(String(err && err.stack || err)); process.exit(1); });
        setTimeout(() => { process.stdout.write(JSON.stringify(Object.keys(require.cache))); process.exit(0); }, 1500);
      `;
      const out = execFileSync(process.execPath, ['-e', script], {
        cwd: ROOT,
        env: { ...process.env, KL_GRAPH_DATA_DIR: dataDir, KING_LOUIE_LOG_LEVEL: 'silent' }
      }).toString();
      const loaded = JSON.parse(out).map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
      assert.ok(loaded.includes('src/mcp/stdio-server.js'));
      assert.ok(!loaded.includes('src/mcp/case-tools.js'), 'mcp builds no case tools of its own');
      const bad = loaded.filter((p) => p.startsWith('src/core/') || p.startsWith('src/providers/') || p.startsWith('src/tools/') || p.startsWith('src/mesh/mesh-discovery'));
      assert.deepStrictEqual(bad, []);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('mcp module graph, courier branch', () => {
  it('mcp with the service running routes through the courier and never loads the agent core', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-mcp-courier-graph-'));
    const dataDir = path.join(base, 'data');
    const configDir = path.join(base, 'config');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    for (const d of ['approvals', 'approvals/inbox', 'approvals/outbox']) fs.mkdirSync(path.join(dataDir, d), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(configDir, 'runbooks'), { recursive: true, mode: 0o755 });
    if (process.platform !== 'win32') { fs.chmodSync(base, 0o755); fs.chmodSync(configDir, 0o755); fs.chmodSync(path.join(configDir, 'runbooks'), 0o755); }
    fs.writeFileSync(path.join(configDir, 'node.yaml'), 'name: web-01\nprofile: runbook\n', { mode: 0o644 });
    const adminUid = typeof process.geteuid === 'function' ? process.geteuid() : 0;
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // As root, mcp drops to the data dir's owner (ruling T13-dropprivs):
      // give the data dir a service account so that path is the one taken.
      fs.chmodSync(base, 0o755);
      for (const d of ['', 'approvals', 'approvals/inbox', 'approvals/outbox']) fs.chownSync(path.join(dataDir, d), 1000, 1000);
    }
    try {
      // The pidfile names the child itself, so the service looks live and
      // runMcp takes the courier branch.
      const script = `
        const fs = require('fs');
        const path = require('path');
        const { PassThrough } = require('stream');
        const dataDir = process.env.KL_GRAPH_DATA_DIR;
        fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
        const { runMcp } = require('./src/service/commands/mcp');
        runMcp({ dataDir, io: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
          deps: { configDir: process.env.KL_GRAPH_CONFIG_DIR, adminUid: Number(process.env.KL_GRAPH_ADMIN_UID) } })
          .catch((err) => { process.stderr.write(String(err && err.stack || err)); process.exit(1); });
        setTimeout(() => { process.stdout.write(JSON.stringify(Object.keys(require.cache))); process.exit(0); }, 1000);
      `;
      const out = execFileSync(process.execPath, ['-e', script], {
        cwd: ROOT,
        env: { ...process.env, KL_GRAPH_DATA_DIR: dataDir, KL_GRAPH_CONFIG_DIR: configDir, KL_GRAPH_ADMIN_UID: String(adminUid), KING_LOUIE_LOG_LEVEL: 'silent' }
      }).toString();
      const loaded = JSON.parse(out).map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
      assert.ok(loaded.includes('src/fleet/courier-client.js'), 'the courier branch ran');
      assert.ok(!loaded.includes('src/approvals/service-wiring.js'), 'no standalone approvals: the service owns them');
      assert.ok(!loaded.includes('src/mcp/case-tools.js'), 'the case tools run in the service, not in mcp');
      const forbidden = FORBIDDEN.filter((f) => f !== 'src/mcp/');
      const bad = loaded.filter((p) => forbidden.some((f) => p.startsWith(f)) || p.startsWith('src/core/'));
      assert.deepStrictEqual(bad, []);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
