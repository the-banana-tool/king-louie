const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { main } = require('../src/service/cli');
const { createLogger, getLogLevel, setLogLevel } = require('../src/logging');

const createdTempDirs = [];
after(() => { for (const d of createdTempDirs) fs.rmSync(d, { recursive: true, force: true }); });

// A data dir whose sibling `config` dir is the admin config dir the CLI reads
// node.yaml and runbooks from. No node.yaml, so node defaults apply.
function layout({ runbooks = {} } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-cli-mcp-'));
  createdTempDirs.push(base);
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir);
  const configDir = path.join(base, 'config');
  fs.mkdirSync(configDir);
  if (Object.keys(runbooks).length) {
    const dir = path.join(configDir, 'runbooks');
    fs.mkdirSync(dir);
    for (const [file, text] of Object.entries(runbooks)) fs.writeFileSync(path.join(dir, file), text);
  }
  return { dataDir };
}

// stdin is a stream the test controls; stdout and stderr record every write
// as it happens.
function streamIo() {
  const text = { out: '', err: '' };
  return {
    stdin: new PassThrough(),
    stdout: { write: (s) => { text.out += String(s); return true; } },
    stderr: { write: (s) => { text.err += String(s); return true; } },
    text
  };
}

async function waitFor(predicate, what) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function responseWithId(text, id) {
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === id);
}

// `mcp` never resolves once the server is up, so it is started, driven over
// its streams and then left behind with stdin ended; the console methods it
// reroutes are put back here.
async function withMcp(dataDir, fn) {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  const io = streamIo();
  let exitCode;
  main(['mcp', '--data-dir', dataDir], io).then((code) => { exitCode = code; });
  try {
    await fn(io, () => exitCode);
  } finally {
    io.stdin.end();
    Object.assign(console, saved);
  }
}

// Runbook dirs must be root-owned on POSIX, which a test cannot arrange.
const canLoadRunbooks = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

describe('service CLI: mcp', () => {
  it('keeps log output off stdout, which carries only the protocol', async () => {
    const { dataDir } = layout();
    const previousLevel = getLogLevel();
    setLogLevel('info');
    try {
      await withMcp(dataDir, async (io) => {
        io.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
        await waitFor(() => responseWithId(io.text.out, 1), 'initialize response');

        createLogger('cli-mcp-test').info('marker-info-line');
        createLogger('cli-mcp-test').debug('marker-debug-line');
        console.log('marker-console-log');

        assert.match(io.text.err, /marker-info-line/);
        assert.match(io.text.err, /marker-console-log/);
        assert.doesNotMatch(io.text.out, /marker/);
        // Every stdout line is a JSON-RPC message.
        for (const line of io.text.out.split('\n').filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, '2.0');
      });
    } finally {
      setLogLevel(previousLevel);
    }
  });

  it('loads runbooks at startup, so run_runbook finds them without describe_machine first', { skip: !canLoadRunbooks && 'runbook dir must be root-owned on POSIX' }, async () => {
    const { dataDir } = layout({
      runbooks: { 'hello.yaml': 'name: hello\ndescription: says hello\ntier: read\nsteps:\n  - run: [node, --version]\n' }
    });
    await withMcp(dataDir, async (io) => {
      io.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'run_runbook', arguments: { machine: 'unnamed-node', runbook: 'hello' } }
      }) + '\n');
      await waitFor(() => responseWithId(io.text.out, 2), 'run_runbook response');
      const res = responseWithId(io.text.out, 2);
      assert.equal(res.result.isError, undefined, res.result.content[0].text);
      const body = JSON.parse(res.result.content[0].text);
      assert.ok(body.job_id);
      assert.equal(body.status, 'queued');
    });
  });

  it('fails at startup with the error on stderr when a runbook file is invalid', { skip: !canLoadRunbooks && 'runbook dir must be root-owned on POSIX' }, async () => {
    const { dataDir } = layout({ runbooks: { 'bad.yaml': 'name: bad\ntier: bogus\nsteps:\n  - run: [node, --version]\n' } });
    const originalLog = console.log;
    const io = streamIo();
    const code = await main(['mcp', '--data-dir', dataDir], io);
    assert.equal(code, 1);
    assert.match(io.text.err, /Invalid runbook.*bad\.yaml/);
    assert.equal(io.text.out, '');
    // A failed start hands the console back.
    assert.equal(console.log, originalLog);
  });
});

describe('service CLI: pair', () => {
  it('prints usage without a front-door URL, and no longer offers --code', async () => {
    const io = streamIo();
    assert.equal(await main(['pair'], io), 2);
    assert.match(io.text.err, /Usage: king-louie-service pair <front-door-url>/);
    assert.doesNotMatch(io.text.err, /--code/);

    const withCode = streamIo();
    assert.equal(await main(['pair', 'https://door.example', '--code', '123'], withCode), 2);
    assert.match(withCode.text.err, /Unknown flag "--code"/);
  });

  it('refuses while the service is running on the data dir, and writes nothing', async () => {
    const { dataDir } = layout();
    // This test process stands in for a running service.
    fs.writeFileSync(path.join(dataDir, 'service.pid'), String(process.pid));
    const io = streamIo();
    assert.equal(await main(['pair', 'https://door.example', '--data-dir', dataDir], io), 1);
    assert.match(io.text.err, /The service is running \(pid \d+\)/);
    assert.deepEqual(fs.readdirSync(dataDir), ['service.pid']);
  });

  it('shows the node identity, says pairing is not available yet, and does not wait for input', async () => {
    const { dataDir } = layout();
    // stdin is never ended: a command that waited for it would hang here.
    const io = streamIo();
    assert.equal(await main(['pair', 'https://door.example', '--data-dir', dataDir], io), 1);
    assert.match(io.text.out, /^Node Name: unnamed-node$/m);
    const nodeId = /^Node ID: (kl-[a-z2-7]{16})$/m.exec(io.text.out)?.[1];
    assert.ok(nodeId, io.text.out);
    assert.match(io.text.out, /^TLS Fingerprint: \S+$/m);
    assert.match(io.text.err, /not available yet.*stage 4/);
    assert.doesNotMatch(io.text.out + io.text.err, /Pairing request initiated|Enter one-time pairing code/);

    // The identity was saved, so a second run reports the same node.
    const again = streamIo();
    assert.equal(await main(['pair', 'https://door.example', '--data-dir', dataDir], again), 1);
    assert.match(again.text.out, new RegExp(`^Node ID: ${nodeId}$`, 'm'));
  });
});
