// tests/e2e/single-instance.test.js
// A second desktop on the same profile quits and acts on nothing it was given;
// a launch on another profile is independent.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { launchApp, closeApp, evaluate, childEnv, launchEnv, APP_PATH } = require('./helpers');

const profileMark = (dir) => {
  const file = path.join(dir, 'desktop-bridge.json');
  return fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
};

function secondLaunch(userDataDir, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [APP_PATH, `--user-data-dir=${userDataDir}`, ...args], {
      env: childEnv(launchEnv(userDataDir)),
      stdio: 'ignore'
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error('the second instance did not quit')); }, 30000);
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

describe('E2E: one desktop per profile', () => {
  let ctx;

  before(async () => {
    ctx = await launchApp();
    await ctx.electronApp.evaluate(({ app }) => {
      global.secondInstances = 0;
      app.on('second-instance', () => { global.secondInstances += 1; });
    });
  });

  after(async () => {
    await closeApp(ctx);
  });

  it('a second launch on the same profile quits, and the first hears of it', async () => {
    const mark = profileMark(ctx.userDataDir);
    const code = await secondLaunch(ctx.userDataDir, ['--kl-standalone-once', '--no-such-flag=1']);
    assert.strictEqual(code, 0);
    assert.strictEqual(await ctx.electronApp.evaluate(() => global.secondInstances), 1);
    assert.strictEqual(profileMark(ctx.userDataDir), mark, 'it wrote nothing into the desktop state');
    assert.strictEqual(await evaluate(ctx, `!!document.getElementById('user-input')`), true, 'the first window still answers');
  });

  it('a launch on another profile stands on its own', async () => {
    const other = await launchApp();
    try {
      assert.notStrictEqual(other.userDataDir, ctx.userDataDir);
      assert.strictEqual(await evaluate(other, `!!document.getElementById('user-input')`), true);
      assert.strictEqual(await ctx.electronApp.evaluate(() => global.secondInstances), 1);
    } finally {
      await closeApp(other);
    }
  });
});
