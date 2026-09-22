const { describe, it } = require('node:test');
const assert = require('node:assert');
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'king-louie-service.js');

function startService(profile, { dataDirArg, cwd } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-smoke-'));
  const child = fork(BIN, ['run', '--data-dir', dataDirArg || dataDir, '--profile', profile], {
    silent: true,
    cwd,
    env: { ...process.env, KL_TEST_MODE: '1', KING_LOUIE_LOG_LEVEL: 'info' }
  });
  const ready = new Promise((resolve, reject) => {
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.includes('"event":"ready"'));
      if (line) resolve(JSON.parse(line));
    });
    child.once('exit', (code) => reject(new Error(`exited early with ${code}`)));
  });
  return { child, dataDir, ready };
}

for (const profile of ['agent', 'runbook']) {
  describe(`service smoke (${profile})`, { timeout: 60000 }, () => {
    it('starts, writes a pidfile, and stops cleanly on a shutdown message', async () => {
      const { child, dataDir, ready } = startService(profile);
      const info = await ready;
      assert.strictEqual(info.profile, profile);
      assert.strictEqual(Number(fs.readFileSync(path.join(dataDir, 'service.pid'), 'utf8')), child.pid);
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.send({ type: 'shutdown' });
      assert.strictEqual(await exited, 0);
      assert.strictEqual(fs.existsSync(path.join(dataDir, 'service.pid')), false);
      assert.ok(fs.existsSync(path.join(dataDir, 'key-check')), 'key-check is written on first key resolution');
      // The installers set WorkingDirectory=<dataDir>, which made the secret
      // store the agent's own workspace: master.key, gateway-token,
      // chat-data.json and config.json were all inside `process.cwd()`, and
      // the ungated read tools (Read/Grep/Glob) treat the working directory
      // as in-bounds. The service now runs in an explicit workspace, handed to
      // createCore as its workingDirectory — and the *process* cwd moves there
      // too, because everything createCore does not own (a stdio MCP server
      // spawned without an explicit cwd, the template and hook directory
      // fallbacks) still resolves against process.cwd().
      const workspace = path.join(dataDir, 'workspace');
      assert.ok(fs.statSync(workspace).isDirectory(), 'the service must create its own workspace dir');
      assert.strictEqual(fs.realpathSync(info.workspace), fs.realpathSync(workspace), 'the service must work in its workspace, not the data dir');
      assert.notStrictEqual(fs.realpathSync(info.workspace), fs.realpathSync(dataDir));
      assert.strictEqual(fs.realpathSync(info.cwd), fs.realpathSync(workspace), 'the process cwd must not be the secret store');
      assert.notStrictEqual(fs.realpathSync(info.cwd), fs.realpathSync(dataDir));
      const serviceLog = fs.readFileSync(path.join(dataDir, 'logs', 'service.log'), 'utf8');
      assert.match(serviceLog, /INFO \[service\] service ready/);
      assert.match(serviceLog, /INFO \[service\] stopped/);
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
  });
}

// `ensureWorkspace` chdirs into <dataDir>/workspace before the core starts, so
// a *relative* --data-dir is re-resolved against the new cwd by everything
// created afterwards: the master key, key-check, the pidfile and the memory
// stores land in <dataDir>/workspace/<dataDir> while the log file (written
// before the chdir) stays in <dataDir>. `status` then reports "not running"
// while it runs and `doctor` reports the key missing, and a later `vault set`
// would write against a different key than the live service reads.
describe('service run with a relative --data-dir', { timeout: 60000 }, () => {
  it('keeps every artifact in the one data dir the operator named', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-rel-'));
    const { child, ready } = startService('runbook', { dataDirArg: './d', cwd: base });
    try {
      const info = await ready;
      const dataDir = path.join(base, 'd');

      assert.strictEqual(path.isAbsolute(info.dataDir), true, 'the reported data dir must be absolute');
      assert.strictEqual(fs.realpathSync(info.dataDir), fs.realpathSync(dataDir));

      assert.ok(fs.existsSync(path.join(dataDir, 'service.pid')), 'the pidfile must be in the data dir');
      assert.ok(fs.existsSync(path.join(dataDir, 'key-check')), 'key-check must be in the data dir');
      assert.ok(fs.existsSync(path.join(dataDir, 'logs', 'service.log')), 'the log file must be in the data dir');
      assert.strictEqual(
        fs.existsSync(path.join(dataDir, 'workspace', 'd')),
        false,
        'nothing may be re-resolved against the post-chdir cwd'
      );

      const { readPidfile } = require('../src/service/pidfile');
      assert.strictEqual(readPidfile(dataDir), child.pid, 'status must find the running service');
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.send({ type: 'shutdown' });
      await exited;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

// Copilot review comment C8 (PR #28). With the default feature set no listener
// binds, so nothing used to stop a second `run` on the same data dir: it
// overwrote the first one's pidfile and the two processes then shared the
// cached JSON stores and the cron schedule.
describe('two runs against one data dir', { timeout: 60000 }, () => {
  it('the second one refuses to start and leaves the first one\'s claim alone', async () => {
    const first = startService('runbook');
    const info = await first.ready;
    assert.strictEqual(Number(fs.readFileSync(path.join(first.dataDir, 'service.pid'), 'utf8')), first.child.pid);

    const second = fork(BIN, ['run', '--data-dir', first.dataDir, '--profile', 'runbook'], {
      silent: true,
      env: { ...process.env, KL_TEST_MODE: '1', KING_LOUIE_LOG_LEVEL: 'info' }
    });
    let stderr = '';
    second.stderr.on('data', (d) => { stderr += d; });
    const code = await new Promise((resolve) => second.once('exit', resolve));

    assert.notStrictEqual(code, 0, 'a duplicate run must not report success');
    assert.match(stderr, /already owns/);
    assert.strictEqual(
      Number(fs.readFileSync(path.join(first.dataDir, 'service.pid'), 'utf8')),
      first.child.pid,
      'the live instance must keep its pidfile'
    );

    const exited = new Promise((resolve) => first.child.once('exit', resolve));
    first.child.send({ type: 'shutdown' });
    assert.strictEqual(await exited, 0);
    assert.strictEqual(fs.existsSync(path.join(first.dataDir, 'service.pid')), false);
    assert.strictEqual(info.profile, 'runbook');
    fs.rmSync(first.dataDir, { recursive: true, force: true });
  });
});
