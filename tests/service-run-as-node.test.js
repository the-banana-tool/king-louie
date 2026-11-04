// tests/service-run-as-node.test.js
// A node installed from the desktop runs the app's binary with
// ELECTRON_RUN_AS_NODE=1 (attach stage 2 Task 6 fix round). The service drops
// it from its own environment once at start, so what it spawns for the owner
// (an MCP server, a hook, a shell) never inherits it, and every child that
// needs it sets it itself.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runService } = require('../src/service/run');
const { spawnWriter } = require('../src/service/commands/import-channel');
const BashTool = require('../src/tools/builtin/bash-tool');
const MCPClient = require('../src/mcp/mcp-client');
const HookExecutor = require('../src/hooks/hook-executor');

const dirs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-run-as-node-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const PRINT = `console.log('[' + (process.env.ELECTRON_RUN_AS_NODE === undefined ? 'unset' : 'set') + ']')`;
const STOP = 'test stops the start here';

// runService up to the profile's start, the moment anything could be spawned.
async function atProfileStart(probe) {
  const cwd = process.cwd();
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  let seen;
  try {
    await assert.rejects(runService({
      dataDir: tmpDir(),
      profile: 'agent',
      stdout: { write: () => true },
      deps: { startProfile: async () => { seen = await probe(); throw new Error(STOP); } }
    }), new RegExp(STOP));
  } finally {
    process.chdir(cwd);
    if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = saved;
  }
  return seen;
}

describe('the service and ELECTRON_RUN_AS_NODE', () => {
  it('a shell the Bash tool starts does not inherit it', async () => {
    const script = path.join(tmpDir(), 'print.js');
    fs.writeFileSync(script, `${PRINT};\n`);
    const result = await atProfileStart(() => BashTool.execute({ command: `node "${script}"` }, { useSandbox: false, workingDirectory: path.dirname(script) }));
    assert.match(String(result.stdout), /\[unset\]/);
  });

  it('an MCP server does not inherit it', async () => {
    const dir = tmpDir();
    const out = path.join(dir, 'seen.txt');
    const script = path.join(dir, 'server.js');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.ELECTRON_RUN_AS_NODE === undefined ? 'unset' : 'set');\n`);
    await atProfileStart(async () => {
      const client = new MCPClient({ name: 'probe', command: 'node', args: [script], env: {}, timeoutMs: 3000 });
      await client.connect().catch(() => {});
      try { await client.disconnect?.(); } catch { /* it has exited */ }
    });
    assert.equal(fs.readFileSync(out, 'utf8'), 'unset');
  });

  it('a hook does not inherit it', async () => {
    const dir = tmpDir();
    const script = path.join(dir, 'hook.js');
    const out = path.join(dir, 'seen.txt');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(out)}, process.env.ELECTRON_RUN_AS_NODE === undefined ? 'unset' : 'set');\n`);
    await atProfileStart(async () => {
      const executor = new HookExecutor({ registry: { list: () => [] }, workingDirectory: dir });
      await executor.executeHook({ name: 'probe', handler: `shell:node "${script}"`, directory: dir }, { event: 'PreToolUse', toolName: 'Read' });
    });
    assert.equal(fs.readFileSync(out, 'utf8'), 'unset');
  });

  it('a one-shot CLI command keeps it: only `run` drops it', () => {
    const entry = path.join(__dirname, '..', 'bin', 'king-louie-service.js');
    const script = `process.argv=[process.argv[0],${JSON.stringify(entry)},'--help'];require(${JSON.stringify(entry)});process.on('exit',()=>{process.stderr.write(process.env.ELECTRON_RUN_AS_NODE==='1'?'KEPT':'LOST')});`;
    const r = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', cwd: tmpDir() });
    assert.match(r.stderr, /KEPT/);
  });
});

describe('the import writer sets it for itself', () => {
  const fakeSpawn = () => {
    const calls = [];
    const { EventEmitter } = require('events');
    const spawn = (file, args, opts) => {
      calls.push(opts);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => true, end: () => {}, on: () => {} };
      child.kill = () => {};
      return child;
    };
    return { calls, spawn };
  };

  it('under the app binary, with or without a trimmed environment', () => {
    for (const identity of [null, { uid: 1000, gid: 1000 }]) {
      const { calls, spawn } = fakeSpawn();
      spawnWriter({ dataDir: tmpDir(), identity, spawn, env: {}, electron: true });
      assert.equal(calls[0].env.ELECTRON_RUN_AS_NODE, '1');
    }
  });

  it('under plain Node it adds nothing', () => {
    const { calls, spawn } = fakeSpawn();
    spawnWriter({ dataDir: tmpDir(), spawn, env: {}, electron: false });
    assert.equal('ELECTRON_RUN_AS_NODE' in calls[0].env, false);
  });
});

// The real binary: the variable gone from this process, the two workers that
// need it still start, because each sets it itself. Under Electron a worker
// that inherited would open the app instead of running its script.
describe('the workers under the real app binary, with the variable gone', () => {
  it('the PDF and embed workers run', { timeout: 120000 }, (t) => {
    let electron;
    try { electron = require('electron'); } catch { electron = null; }
    if (typeof electron !== 'string' || !fs.existsSync(electron)) { t.skip('no Electron binary here'); return; }
    const root = path.join(__dirname, '..');
    const script = path.join(tmpDir(), 'probe.js');
    fs.writeFileSync(script, `
      delete process.env.ELECTRON_RUN_AS_NODE;
      const path = require('path');
      const root = ${JSON.stringify(root)};
      (async () => {
        const { EmbedRunner } = require(path.join(root, 'src/history/embed-runner'));
        const runner = new EmbedRunner({ testBackend: path.join(root, 'tests/helpers/fake-embed-backend.js') });
        await runner.load('embedder', 'fake/one', { modelsDir: path.join(require('os').tmpdir(), 'kl-embed-models-unused') });
        const vecs = await runner.embed('fake/one', ['gate code']);
        await runner.stop();
        const { makePdf } = require(path.join(root, 'tests/helpers/ingest-fixtures'));
        const sandbox = require(path.join(root, 'src/cases/ingest/pdf-sandbox'));
        const doc = await sandbox.openPdfIsolated(await makePdf());
        const pages = doc.pageCount;
        await doc.close();
        await sandbox.shutdownPdfSandbox();
        console.log('WORKERS ' + vecs.length + ' ' + pages);
        process.exit(0);
      })().catch((e) => { console.log('FAILED ' + e.stack); process.exit(1); });
    `);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const r = spawnSync(electron, [script], { env, encoding: 'utf8', timeout: 100000, cwd: root, windowsHide: true });
    assert.match(r.stdout, /WORKERS 1 1/, `${r.stdout}\n${r.stderr}`);
  });
});
