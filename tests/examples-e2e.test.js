// tests/examples-e2e.test.js
// Runs every example runbook end to end on every OS: the parsed runbook's
// programs are swapped for fakes that record their argv (spec §4.4), and the
// jobs go through the real StdioMcpServer and RunbookEngine.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { loadNodeConfig } = require('../src/service/node-config');
const { RunbookEngine } = require('../src/runbooks/runbook-engine');
const { EvidenceLedger } = require('../src/verification/evidence-ledger');
const { MeshIdentity } = require('../src/mesh/mesh-identity');
const { connectStdioMcp } = require('./helpers/stdio-mcp-client');
const { prepareRunbook, makeFakes, readCalls } = require('./helpers/example-fixture');

const EXAMPLES = path.join(__dirname, '..', 'examples');
const EUID = typeof process.geteuid === 'function' ? process.geteuid() : 0;
const POSIX = process.platform !== 'win32';
const REF_PATTERN = String.raw`^(main|release/[A-Za-z0-9][A-Za-z0-9._-]{0,39}|v[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})$`;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
const closeServer = (server) => new Promise((resolve) => server.close(resolve));

function rewriteKeys(rewrite) {
  return [
    ...Object.keys(rewrite.programs || {}),
    ...Object.keys(rewrite.prefixes || {}),
    ...Object.keys(rewrite.urls || {})
  ];
}

// One node: its example node.yaml in <tmp>/config, the named runbooks
// rewritten into <tmp>/config/runbooks, fakes in <tmp>/fakes, a real engine
// with an in-memory evidence ledger, and an MCP client on in-memory stdio.
// Every rewrite key must be hit, so an edited example cannot silently fall
// through to a real program.
async function setupNode(role, runbookFiles, rewriteFor, fakeNames) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `kl-example-${role}-`));
  const config = path.join(tmp, 'config');
  fs.mkdirSync(config);
  if (POSIX) fs.chmodSync(config, 0o755);
  const nodeYaml = path.join(config, 'node.yaml');
  fs.copyFileSync(path.join(EXAMPLES, 'fleet', role, 'node.yaml'), nodeYaml);
  if (POSIX) fs.chmodSync(nodeYaml, 0o644);
  makeFakes(tmp, fakeNames);

  const rewrite = { tmp, ...rewriteFor(tmp) };
  const hits = new Set();
  for (const f of runbookFiles) {
    for (const key of prepareRunbook(path.join(EXAMPLES, 'runbooks', f), rewrite).hits) hits.add(key);
  }
  assert.deepEqual(rewriteKeys(rewrite).filter((k) => !hits.has(k)), [], 'rewrite keys the examples no longer use');

  const nodeConfig = loadNodeConfig({ adminConfigDir: config, geteuid: () => EUID, adminUid: EUID });
  const evidenceLedger = new EvidenceLedger();
  const engine = new RunbookEngine({
    runbooksDir: nodeConfig.runbooksDir,
    allowedRoots: nodeConfig.policy.allowed_roots,
    geteuid: () => EUID,
    adminUid: EUID,
    evidenceLedger,
    killGraceMs: 200
  });
  engine.loadRunbooks();
  const client = connectStdioMcp({ nodeConfig, runbookEngine: engine });
  return {
    tmp,
    hits,
    rewrite,
    nodeConfig,
    engine,
    client,
    // The engine records evidence against its own cwd, which is ours.
    evidence: (runbook) => evidenceLedger.status(process.cwd()).freshEvents.filter((e) => e.tool === `runbook:${runbook}`),
    calls: () => readCalls(tmp),
    fail: (selector, code, stderr) => fs.writeFileSync(path.join(tmp, 'fail', selector), `${code}\n${stderr}\n`),
    async cleanup() {
      await client.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

async function runOverMcp(node, machine, runbook, params = {}) {
  const started = await node.client.callTool('run_runbook', { machine, runbook, params });
  assert.equal(started.status, 'queued', JSON.stringify(started));
  return node.client.waitForJob(started.job_id, ['succeeded', 'failed', 'cancelled']);
}

describe('prepareRunbook: every run step must be rewritten', () => {
  it('throws naming the runbook, step and program when a run step\'s argv[0] is not in `programs`', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-example-rewrite-'));
    try {
      assert.throws(
        () => prepareRunbook(path.join(EXAMPLES, 'runbooks', 'site.status.yaml'), { tmp, programs: {}, prefixes: {}, urls: {} }),
        (err) => {
          assert.match(err.message, /site\.status/);
          assert.match(err.message, /step 1/);
          assert.match(err.message, /"\/usr\/bin\/git"/);
          return true;
        }
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

const WEB01_FILES = ['site.status.yaml', 'site.pull_and_restart.yaml', 'server.reboot.yaml'];
const WEB01_FAKES = ['git', 'sudo', 'systemctl', 'build'];
const web01Rewrite = (baseUrl) => (tmp) => ({
  programs: { '/usr/bin/git': 'git', '/usr/bin/sudo': 'sudo', '/usr/bin/systemctl': 'systemctl', '/srv/site/bin/build': 'build' },
  prefixes: { '/srv/site': path.join(tmp, 'srv', 'site') },
  urls: { 'http://127.0.0.1:8080': baseUrl }
});

describe('web-01 examples end to end', () => {
  let health;
  before(async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = req.url === '/healthz' ? 200 : 404;
      res.end('ok');
    });
    const port = await listen(server);
    health = { url: `http://127.0.0.1:${port}`, close: () => closeServer(server) };
  });
  after(() => health.close());

  const web01 = () => setupNode('web-01', WEB01_FILES, web01Rewrite(health.url), WEB01_FAKES);

  it('describe_machine lists the three runbooks with their tiers and params', async () => {
    const node = await web01();
    try {
      const d = await node.client.callTool('describe_machine', { machine: 'web-01' });
      assert.equal(d.profile, 'runbook');
      assert.deepEqual(
        Object.fromEntries(d.runbooks.map((r) => [r.name, r.tier])),
        { 'site.status': 'read', 'site.pull_and_restart': 'unsafe', 'server.reboot': 'unsafe' }
      );
      const pull = d.runbooks.find((r) => r.name === 'site.pull_and_restart');
      assert.deepEqual(pull.params.ref, { type: 'string', pattern: REF_PATTERN, default: 'main' });
    } finally {
      await node.cleanup();
    }
  });

  it('site.status over MCP: queued, then succeeded, with the check recorded as evidence', async () => {
    const node = await web01();
    try {
      const job = await runOverMcp(node, 'web-01', 'site.status');
      assert.equal(job.status, 'succeeded', JSON.stringify(job));
      assert.equal(job.output.untrusted_output, true);
      assert.deepEqual(node.calls(), [
        { fake: 'git', argv: ['-C', path.join(node.tmp, 'srv', 'site'), 'log', '-1', '--format=%H %cI %s'] },
        { fake: 'systemctl', argv: ['is-active', 'site.service'] }
      ]);
      const evidence = node.evidence('site.status');
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].status, 'passed');
    } finally {
      await node.cleanup();
    }
  });

  it('site.pull_and_restart and server.reboot over MCP are denied and run nothing (F2, D1)', async () => {
    const node = await web01();
    try {
      for (const [runbook, params] of [['site.pull_and_restart', { ref: 'main' }], ['server.reboot', {}]]) {
        const res = await node.client.callTool('run_runbook', { machine: 'web-01', runbook, params });
        assert.equal(res.status, 'denied', JSON.stringify(res));
        assert.match(res.reason, /^denied_by_policy/);
      }
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(node.calls(), []);
    } finally {
      await node.cleanup();
    }
  });

  it.todo('site.pull_and_restart over MCP: awaiting_approval, the fake phone signs, succeeded (fleet stage 3)');

  it('site.pull_and_restart, approved path: fetch, detached checkout, build, sudo restart, evidence passed', async () => {
    const node = await web01();
    try {
      const res = await node.engine.executeRunbook('site.pull_and_restart', { ref: 'main' });
      assert.equal(res.success, true, JSON.stringify(res));
      const site = path.join(node.tmp, 'srv', 'site');
      assert.deepEqual(node.calls(), [
        { fake: 'git', argv: ['-C', site, 'fetch', '--prune', 'origin', 'main'] },
        { fake: 'git', argv: ['-C', site, 'checkout', '--detach', 'FETCH_HEAD'] },
        { fake: 'build', argv: [] },
        { fake: 'sudo', argv: ['-n', '/usr/bin/systemctl', 'restart', 'site.service'] }
      ]);
      assert.deepEqual(node.evidence('site.pull_and_restart').map((e) => e.status), ['passed']);
    } finally {
      await node.cleanup();
    }
  });

  it('server.reboot, approved path: sudo -n shutdown -r +1', async () => {
    const node = await web01();
    try {
      const res = await node.engine.executeRunbook('server.reboot', {});
      assert.equal(res.success, true, JSON.stringify(res));
      assert.deepEqual(node.calls(), [{ fake: 'sudo', argv: ['-n', '/usr/sbin/shutdown', '-r', '+1'] }]);
    } finally {
      await node.cleanup();
    }
  });

  it('sudo -n not configured: fails at step 4, no evidence, stderr in the logs', async () => {
    const node = await web01();
    try {
      node.fail('sudo', 1, 'sudo: a password is required');
      const res = await node.engine.executeRunbook('site.pull_and_restart', { ref: 'main' });
      assert.equal(res.success, false);
      assert.equal(res.stepIndex, 3);
      assert.equal(res.error, 'Step 4 exited with status 1');
      assert.ok(res.logs.some((l) => l.includes('sudo: a password is required')), JSON.stringify(res.logs));
      assert.deepEqual(node.evidence('site.pull_and_restart'), []);
      assert.deepEqual(node.calls().map((c) => c.fake), ['git', 'git', 'build', 'sudo']);
    } finally {
      await node.cleanup();
    }
  });

  it('git refuses the checkout: fails at step 2, no build or sudo call', async () => {
    const node = await web01();
    try {
      node.fail('git@checkout', 128, 'error: Your local changes to the following files would be overwritten by checkout:\n\tpackage.json');
      const res = await node.engine.executeRunbook('site.pull_and_restart', { ref: 'main' });
      assert.equal(res.success, false);
      assert.equal(res.stepIndex, 1);
      assert.equal(res.error, 'Step 2 exited with status 128');
      assert.ok(res.logs.some((l) => l.includes('would be overwritten by checkout')), JSON.stringify(res.logs));
      assert.deepEqual(node.evidence('site.pull_and_restart'), []);
      assert.deepEqual(node.calls().map((c) => c.fake), ['git', 'git']);
    } finally {
      await node.cleanup();
    }
  });

  it('site.status against a self-signed HTTPS health endpoint fails with evidence failed', async () => {
    const tls = MeshIdentity.generateTlsCertificate('kl-example-test');
    const server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    const port = await listen(server);
    const node = await setupNode('web-01', WEB01_FILES, web01Rewrite(`https://127.0.0.1:${port}`), WEB01_FAKES);
    try {
      const job = await runOverMcp(node, 'web-01', 'site.status');
      assert.equal(job.status, 'failed', JSON.stringify(job));
      assert.ok(job.output.lines.includes('Check step 2 result: FAILED'), JSON.stringify(job.output.lines));
      assert.deepEqual(node.evidence('site.status').map((e) => e.status), ['failed']);
      assert.deepEqual(node.calls().map((c) => c.fake), ['git']);
    } finally {
      await node.cleanup();
      await closeServer(server);
    }
  });
});

const LAPTOP_FILES = ['laptop.build_then_deploy.yaml'];
const NPM_CLI = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
const laptopRewrite = (tmp) => ({
  programs: { 'C:\\Program Files\\Git\\cmd\\git.exe': 'git', 'C:\\Program Files\\nodejs\\node.exe': 'node' },
  prefixes: { 'C:\\build\\site': path.join(tmp, 'build', 'site'), [NPM_CLI]: path.join(tmp, 'fakes', 'npm-cli.js') }
});

const GPU_FILES = ['models.hf_download.yaml', 'train.run.yaml'];
const HF = 'C:\\KingLouie\\tools\\py\\Scripts\\hf.exe';
const PYTHON = 'C:\\KingLouie\\tools\\py\\Scripts\\python.exe';
const gpuRewrite = (hf = 'hf') => (tmp) => ({
  programs: { [HF]: typeof hf === 'function' ? hf(tmp) : hf, [PYTHON]: 'python' },
  prefixes: { 'D:\\models': path.join(tmp, 'ML Data', 'models'), 'D:\\train': path.join(tmp, 'ML Data', 'train') }
});

describe('laptop and gpu-box examples end to end', () => {
  it('laptop.build_then_deploy over MCP: fetch, checkout, then npm ci, build and test through node.exe', async () => {
    const node = await setupNode('laptop', LAPTOP_FILES, laptopRewrite, ['git', 'node']);
    try {
      const job = await runOverMcp(node, 'laptop', 'laptop.build_then_deploy', { ref: 'release/2.1' });
      assert.equal(job.status, 'succeeded', JSON.stringify(job));
      const site = path.join(node.tmp, 'build', 'site');
      const npmCli = path.join(node.tmp, 'fakes', 'npm-cli.js');
      assert.deepEqual(node.calls(), [
        { fake: 'git', argv: ['-C', site, 'fetch', '--prune', 'origin', 'release/2.1'] },
        { fake: 'git', argv: ['-C', site, 'checkout', '--detach', 'FETCH_HEAD'] },
        { fake: 'node', argv: [npmCli, '--prefix', site, 'ci'] },
        { fake: 'node', argv: [npmCli, '--prefix', site, 'run', 'build'] },
        { fake: 'node', argv: [npmCli, '--prefix', site, 'test'] }
      ]);
    } finally {
      await node.cleanup();
    }
  });

  it('models.hf_download over MCP passes the spaced destination as one argument', async () => {
    const node = await setupNode('gpu-box', GPU_FILES, gpuRewrite(), ['hf', 'python']);
    try {
      const job = await runOverMcp(node, 'gpu-box', 'models.hf_download', { repo: 'example-org/example-model', dest: 'example' });
      assert.equal(job.status, 'succeeded', JSON.stringify(job));
      assert.deepEqual(node.calls(), [{
        fake: 'hf',
        argv: ['download', 'example-org/example-model', '--revision', 'main', '--local-dir', `${path.join(node.tmp, 'ML Data', 'models')}\\example`]
      }]);
    } finally {
      await node.cleanup();
    }
  });

  it('train.run over MCP reads its config from the admin-owned configs folder, with the defaults filled in', async () => {
    const node = await setupNode('gpu-box', GPU_FILES, gpuRewrite(), ['hf', 'python']);
    try {
      const job = await runOverMcp(node, 'gpu-box', 'train.run', { config: 'base' });
      assert.equal(job.status, 'succeeded', JSON.stringify(job));
      const train = path.join(node.tmp, 'ML Data', 'train');
      assert.deepEqual(node.calls(), [{
        fake: 'python',
        argv: [`${train}\\train.py`, '--config', `${train}\\configs\\base.json`, '--epochs', '1', '--precision', 'bf16', '--resume=false']
      }]);
    } finally {
      await node.cleanup();
    }
  });

  it('hf.exe missing: the job fails with ENOENT', async () => {
    const node = await setupNode('gpu-box', GPU_FILES, gpuRewrite((tmp) => ({ path: path.join(tmp, 'missing', 'hf.exe') })), ['python']);
    try {
      const job = await runOverMcp(node, 'gpu-box', 'models.hf_download', { repo: 'example-org/example-model', dest: 'example' });
      assert.equal(job.status, 'failed', JSON.stringify(job));
      assert.match(job.result, /ENOENT/);
      assert.deepEqual(node.calls(), []);
    } finally {
      await node.cleanup();
    }
  });

  it('every rewrite key of every role is hit by the examples', async () => {
    const roles = [
      ['web-01', WEB01_FILES, web01Rewrite('http://127.0.0.1:9'), WEB01_FAKES],
      ['laptop', LAPTOP_FILES, laptopRewrite, ['git', 'node']],
      ['gpu-box', GPU_FILES, gpuRewrite(), ['hf', 'python']]
    ];
    for (const [role, files, rewriteFor, fakes] of roles) {
      // setupNode's own assert.deepEqual (unhit-key check) is the actual
      // check here: every rewrite key of every role must be hit.
      const node = await setupNode(role, files, rewriteFor, fakes);
      try {
        assert.ok(rewriteKeys(node.rewrite).length > 0);
      } finally {
        await node.cleanup();
      }
    }
  });
});
