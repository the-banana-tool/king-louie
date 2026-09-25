// tests/e2e-harness.test.js — unit checks of the e2e harness (no Electron launched).
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const helpers = require('./e2e/helpers');
const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

describe('e2e harness', () => {
  it('exports the harness API', () => {
    for (const name of ['launchApp', 'relaunchApp', 'launchAttached', 'startTestService', 'closeApp', 'evaluate', 'waitFor', 'click', 'fill', 'getText', 'getValue', 'isVisible', 'count', 'childEnv', 'launchEnv', 'writeSeed', 'APP_PATH']) {
      assert.ok(name in helpers, name);
    }
  });

  it('removes ELECTRON_RUN_AS_NODE entirely and sets KL_TEST_MODE', () => {
    const saved = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '';
    try {
      const env = helpers.childEnv({ EXTRA: 'x' });
      assert.ok(!('ELECTRON_RUN_AS_NODE' in env));
      assert.strictEqual(env.KL_TEST_MODE, '1');
      assert.strictEqual(env.EXTRA, 'x');
    } finally {
      if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = saved;
    }
  });

  it('writes seed files, JSON or text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-seed-'));
    dirs.push(dir);
    helpers.writeSeed(dir, { 'chat-data.json': { onboardingComplete: true }, 'notes/a.txt': 'hello' });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'chat-data.json'), 'utf8')), { onboardingComplete: true });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'notes', 'a.txt'), 'utf8'), 'hello');
  });

  it('never inherits a parent KL_CASES_ROOT into the child launch environment (fix round 1, I2)', () => {
    const saved = process.env.KL_CASES_ROOT;
    process.env.KL_CASES_ROOT = path.join(os.tmpdir(), 'a-real-cases-root-that-must-not-leak');
    try {
      const fakeUserDataDir = path.join(os.tmpdir(), 'kl-e2e-fake-profile');
      const env = helpers.childEnv(helpers.launchEnv(fakeUserDataDir));
      assert.strictEqual(env.KL_CASES_ROOT, path.join(fakeUserDataDir, 'cases'));
      assert.notStrictEqual(env.KL_CASES_ROOT, process.env.KL_CASES_ROOT);
    } finally {
      if (saved === undefined) delete process.env.KL_CASES_ROOT; else process.env.KL_CASES_ROOT = saved;
    }
  });

  it('lets launchApp opts.env override the KL_CASES_ROOT and KL_DESKTOP_BRIDGE_FILE defaults', () => {
    const fakeUserDataDir = path.join(os.tmpdir(), 'kl-e2e-fake-profile-2');
    const env = helpers.launchEnv(fakeUserDataDir, { KL_CASES_ROOT: '/explicit/cases', KL_DESKTOP_BRIDGE_FILE: '/explicit/bridge.json' });
    assert.strictEqual(env.KL_CASES_ROOT, '/explicit/cases');
    assert.strictEqual(env.KL_DESKTOP_BRIDGE_FILE, '/explicit/bridge.json');
  });

  it('the old HTTP test bridge is gone', () => {
    assert.strictEqual(fs.existsSync(path.join(ROOT, 'tests', 'e2e', '_bridge.js')), false);
    const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    assert.ok(!main.includes('KL_TEST_BRIDGE_PORT'));
  });
});
