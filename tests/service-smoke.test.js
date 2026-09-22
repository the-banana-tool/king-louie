const { describe, it } = require('node:test');
const assert = require('node:assert');
const { fork } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BIN = path.join(__dirname, '..', 'bin', 'king-louie-service.js');

function startService(profile) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-svc-smoke-'));
  const child = fork(BIN, ['run', '--data-dir', dataDir, '--profile', profile], {
    silent: true,
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
      // as in-bounds. The service now runs in an explicit workspace instead,
      // handed to createCore as its workingDirectory rather than installed
      // with process.chdir() — so the check is on the reported workspace, not
      // on the process's cwd, which the service deliberately no longer moves.
      const workspace = path.join(dataDir, 'workspace');
      assert.ok(fs.statSync(workspace).isDirectory(), 'the service must create its own workspace dir');
      assert.strictEqual(fs.realpathSync(info.workspace), fs.realpathSync(workspace), 'the service must work in its workspace, not the data dir');
      assert.notStrictEqual(fs.realpathSync(info.workspace), fs.realpathSync(dataDir));
      const serviceLog = fs.readFileSync(path.join(dataDir, 'logs', 'service.log'), 'utf8');
      assert.match(serviceLog, /INFO \[service\] service ready/);
      assert.match(serviceLog, /INFO \[service\] stopped/);
      fs.rmSync(dataDir, { recursive: true, force: true });
    });
  });
}
