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
    env: { ...process.env, KL_TEST_MODE: '1', KING_LOUIE_LOG_LEVEL: 'warn' }
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
    });
  });
}
