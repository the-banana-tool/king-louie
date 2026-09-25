const { describe, it } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FORBIDDEN = ['src/providers/', 'src/execution/agent-loop', 'src/tools/', 'src/browser/', 'src/channels/', 'src/mcp/', 'src/core/create-core', 'src/execution/safety-policy'];

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
