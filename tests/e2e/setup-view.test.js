// tests/e2e/setup-view.test.js
// The setup view in the real window (attach stage 2 spec §6.2, §6.3, §10). Windows only.
//
// Two launches are as they are: a fresh profile with nothing stubbed, where nothing is
// pressed, and the development flag. The fresh one points ProgramData and LOCALAPPDATA at
// empty temp folders and clears the harness's bridge file, whose test override would
// answer "not applicable". Windows' own task list cannot be pointed anywhere, so a machine
// with a King Louie Node task (read, never run) answers the refusal, and one with none,
// as on CI, answers Install: the test takes either, and the Install screen is also drawn below. The screens that need a node, a plan or an elevated
// app come from the real describeSetup over a status a test writes, handed to the real
// renderer by swapping the main process's own IPC handlers through Playwright: no install,
// no logon task and no node runs, and the app holds no test path for it.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchApp, closeApp, evaluate, waitFor, isVisible } = require('./helpers');
const { describeSetup } = require('../../src/desktop-bridge/setup-flow');

const skip = process.platform !== 'win32' ? 'the setup view is the Windows launch path' : false;
const SHOTS = path.join(os.tmpdir(), 'kl-setup-view-shots');

async function shot(ctx, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const page = await ctx.electronApp.firstWindow();
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

// No files of a node or a service, whatever this machine holds.
function freshMachineEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-machine-'));
  for (const sub of ['ProgramData', 'LocalAppData']) fs.mkdirSync(path.join(dir, sub));
  return { dir, env: { ProgramData: path.join(dir, 'ProgramData'), LOCALAPPDATA: path.join(dir, 'LocalAppData'), KL_DESKTOP_BRIDGE_FILE: '' } };
}

const shown = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return Boolean(el && el.checkVisibility()); })()`;
const viewText = () => `document.getElementById('setup-view').innerText`;

// The main process answers these as the test says, and records each press.
const PRESSES = ['nodeInstallPreview', 'nodeInstall', 'nodeStart', 'nodeRestart', 'pairStart', 'pairConfirm', 'pairCancel', 'pairRestartConfirm', 'migrationPlan', 'migrationApply', 'setupLater', 'setupFinish', 'attach', 'retry'];

async function installStub(ctx) {
  await ctx.electronApp.evaluate(({ ipcMain }, { presses: ids }) => {
    const stub = { status: null, answer: null, presses: [], saves: [], saveAnswer: { ok: true } };
    globalThis.klStub = stub;
    ipcMain.removeHandler('desktop:status');
    ipcMain.handle('desktop:status', () => stub.status);
    ipcMain.removeHandler('desktop:setupStep');
    ipcMain.handle('desktop:setupStep', () => stub.answer);
    for (const id of ids) {
      ipcMain.removeHandler(`desktop:${id}`);
      ipcMain.handle(`desktop:${id}`, (_e, payload) => { stub.presses.push({ id, payload }); return { ok: true }; });
    }
    for (const channel of ['settings:saveProvider', 'settings:saveUserProfile']) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_e, payload) => { stub.saves.push({ channel, keys: Object.keys(payload || {}) }); return stub.saveAnswer; });
    }
  }, { presses: PRESSES });
}

// A status as the controller gives it, and the real describeSetup's answer to it.
async function showStatus(ctx, facts) {
  const status = { ok: true, mode: 'attached', view: 'attached-connected', platform: 'win32', launch: { host: 'attached', why: 'needs-node' }, setup: {}, connection: { status: 'disconnected' }, unavailableTabs: [], ...facts };
  const answer = { ok: true, ...describeSetup(status) };
  status.setup = { ...status.setup, step: answer.step };
  await ctx.electronApp.evaluate(({ BrowserWindow }, { status: st, answer: an }) => {
    globalThis.klStub.status = st;
    globalThis.klStub.answer = an;
    BrowserWindow.getAllWindows()[0].webContents.send('desktop:statusChanged', {});
  }, { status, answer });
  return answer;
}

const presses = (ctx) => ctx.electronApp.evaluate(() => globalThis.klStub.presses);
const saves = (ctx) => ctx.electronApp.evaluate(() => globalThis.klStub.saves);

const paired = { hosting: 'personal', dataDir: 'C:\\Users\\example\\AppData\\Local\\KingLouie\\node\\data', name: 'Example', nodeId: 'kl-abc' };
const LONG_DIR = `C:\\Users\\example\\AppData\\Roaming\\king-louie-migration-backup-2026-11-04T10-00-00\\${'a-very-long-folder-name-with-no-spaces-at-all-'.repeat(6)}backup`;
const connected = (extra = {}) => ({
  pairing: { service: paired },
  connection: { status: 'connected' },
  service: { hosting: 'personal', providersConfigured: true },
  oldProfile: { found: false },
  node: { personal: true, task: 'registered', running: true },
  ...extra
});
const planOnScreen = () => connected({
  oldProfile: { found: true, chats: 42, messages: 1234, cases: 3, bytes: 52428800 },
  migrationPlan: {
    ok: true,
    backup: { dest: LONG_DIR, bytes: 52428800, files: 310, history: { chats: 42, messages: 1234 } },
    plan: {
      counts: { new: 45, 'skip-excluded': 2 },
      items: [
        ...Array.from({ length: 42 }, (_, i) => ({ category: 'chat', key: `c${i}`, action: 'new' })),
        ...Array.from({ length: 3 }, (_, i) => ({ category: 'case', key: `k${i}`, action: 'new' })),
        { category: 'settings', key: 'voice', action: 'skip-excluded' }
      ],
      private: { note: 'One private chat moves too. It stays private on the node, and its calls need a local model there.' }
    },
    staysBehind: ['Browser profiles and their logins', 'Voice settings and files', '<img src=x onerror="document.body.dataset.pwned=1"> a name the old profile held'],
    leftBehind: { secrets: [{ category: 'provider', key: 'openai', note: 'Enter it again on the node.' }] }
  }
});

function widthOverflow(ctx) {
  return evaluate(ctx, `(() => {
    const view = document.getElementById('setup-view');
    const inner = view.querySelector('.setup-card');
    const bad = [];
    if (view.scrollWidth > view.clientWidth + 1) bad.push('view ' + view.scrollWidth + '>' + view.clientWidth);
    const right = view.getBoundingClientRect().right;
    for (const el of inner.querySelectorAll('*')) {
      if (el.getBoundingClientRect().right > right + 1) bad.push(el.id || el.tagName);
    }
    return bad;
  })()`);
}

describe('E2E: the setup view', { skip }, () => {
  describe('a fresh profile, nothing stubbed and nothing pressed', () => {
    let ctx;
    before(async () => {
      const machine = freshMachineEnv();
      ctx = await launchApp({ attached: true, seed: null, env: machine.env });
      ctx.extraDirs.push(machine.dir);
    });
    after(async () => { await closeApp(ctx); });

    it('shows the view within 20 s, and no chat', async () => {
      await waitFor(ctx, shown('#setup-view'), 20000);
      await waitFor(ctx, `document.getElementById('setup-lines').textContent.length > 0 || document.getElementById('setup-error').textContent.length > 0`, 20000);
      assert.strictEqual(await evaluate(ctx, `document.documentElement.classList.contains('setup-pending')`), false);
      assert.strictEqual(await evaluate(ctx, shown('#user-input')), false);
      assert.strictEqual(await evaluate(ctx, shown('.sidebar')), false);
      assert.strictEqual(await evaluate(ctx, shown('#open-settings-btn')), false);
      assert.strictEqual(await isVisible(ctx, '#user-input'), false);
    });

    it('offers Install, or says what stops it, with a primary press either way', async () => {
      // The read of the old profile can hold the reading line for a while first.
      await waitFor(ctx, `Boolean(document.getElementById('setup-action-nodeInstallPreview')) || document.getElementById('setup-error').textContent.length > 0`, 20000);
      assert.ok(await evaluate(ctx, shown('#setup-actions .btn-primary')), 'a primary press');
      await shot(ctx, '1-fresh');
    });

    it('the wizard does not open over it', async () => {
      assert.strictEqual(await evaluate(ctx, `document.getElementById('wizard-overlay').hidden`), true);
    });

    it('the panes behind it say they have no answer, not "none"', async () => {
      const skills = await waitFor(ctx, `(() => { const t = document.getElementById('skills-status').textContent; return t && t !== 'Loading skills...' ? t : ''; })()`, 15000);
      assert.match(skills, /^Error: /);
      assert.doesNotMatch(await evaluate(ctx, `document.getElementById('skills-list').textContent`), /No skills loaded/);
      assert.match(await evaluate(ctx, `document.getElementById('hooks-status').textContent`), /^Error: /);
      const webhooks = await waitFor(ctx, `(() => { const t = document.getElementById('webhook-list-status').textContent; return t !== 'Loading webhooks...' ? t : ''; })()`, 15000);
      assert.match(webhooks, /^Error: /);
    });

    it('nothing was paired', async () => {
      const state = await evaluate(ctx, `window.electron.desktop.status()`);
      assert.ok(!state.pairing, 'no pairing');
    });
  });

  it('a finished setup with no pairing still shows the view', async () => {
    const machine = freshMachineEnv();
    const ctx = await launchApp({ attached: true, env: machine.env, seed: { 'desktop-bridge.json': { mode: 'standalone', setup: { completedAt: '2026-11-03T00:00:00Z' }, installId: 'x' } } });
    ctx.extraDirs.push(machine.dir);
    try {
      await waitFor(ctx, shown('#setup-view'), 20000);
      await waitFor(ctx, shown('#setup-actions .btn-primary'), 20000);
      assert.strictEqual(await evaluate(ctx, shown('#user-input')), false);
    } finally {
      await closeApp(ctx);
    }
  });

  describe('the screens a node or a plan brings', () => {
    let ctx;
    before(async () => {
      ctx = await launchApp({ attached: true, seed: null });
      await waitFor(ctx, shown('#setup-view'), 20000);
      await installStub(ctx);
    });
    after(async () => { await closeApp(ctx); });

    it('an old profile with a plan: backup path, counts, what stays behind, the private note', async () => {
      const answer = await showStatus(ctx, planOnScreen());
      await waitFor(ctx, `document.getElementById('setup-lines').textContent.includes('A backup was made')`, 10000);
      const text = await evaluate(ctx, viewText());
      assert.ok(text.includes('a-very-long-folder-name'), 'the backup path');
      assert.match(text, /Chats: 42 new/);
      assert.match(text, /Cases: 3 new/);
      assert.match(text, /Stays on this computer/);
      assert.match(text, /Voice settings and files/);
      assert.match(text, /One private chat moves too/);
      assert.deepStrictEqual(answer.actions.map((a) => a.id), ['migrationApply', 'setupLater']);
      assert.strictEqual(await evaluate(ctx, shown('#setup-action-migrationApply')), true);
      assert.strictEqual(await evaluate(ctx, `document.getElementById('setup-action-migrationApply').classList.contains('btn-primary')`), true);
      assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('#setup-view img').length`), 0, 'a name from the old profile is text');
      assert.strictEqual(await evaluate(ctx, `document.body.dataset.pwned || null`), null);
      assert.deepStrictEqual(await widthOverflow(ctx), []);
      await shot(ctx, '2-plan');
    });

    it('the plan holds on a narrow window: nothing sticks out, and the press can be reached', async () => {
      await ctx.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(420, 560));
      await new Promise((r) => setTimeout(r, 400));
      assert.deepStrictEqual(await widthOverflow(ctx), []);
      await shot(ctx, '2b-plan-narrow');
      const reached = await evaluate(ctx, `(() => {
        const btn = document.getElementById('setup-action-migrationApply');
        btn.scrollIntoView();
        const r = btn.getBoundingClientRect();
        return r.bottom <= window.innerHeight + 1 && r.top >= 0 && r.right <= window.innerWidth + 1;
      })()`);
      assert.ok(reached, 'scrolling reaches the button');
      await shot(ctx, '2c-plan-narrow-bottom');
      await ctx.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
    });

    it('Move everything passes the owner\'s press', async () => {
      await evaluate(ctx, `document.getElementById('setup-action-migrationApply').click(); true`);
      await waitFor(ctx, `document.getElementById('setup-action-migrationApply') && !document.getElementById('setup-action-migrationApply').disabled`, 10000);
      assert.deepStrictEqual((await presses(ctx)).at(-1), { id: 'migrationApply', payload: { confirmed: true } });
    });

    it('a refusal: the app is elevated', async () => {
      const answer = await showStatus(ctx, { elevated: true, node: { fresh: true } });
      await waitFor(ctx, `document.getElementById('setup-error').textContent.includes('running as administrator')`, 10000);
      assert.deepStrictEqual(answer.actions.map((a) => a.id), ['retry']);
      assert.strictEqual(await evaluate(ctx, shown('#setup-action-retry')), true);
      assert.strictEqual(await evaluate(ctx, shown('#user-input')), false);
      await shot(ctx, '3-elevated');
    });

    it('a press that is refused says why, and the button comes back', async () => {
      await showStatus(ctx, { node: { fresh: true } });
      await waitFor(ctx, shown('#setup-action-nodeInstallPreview'), 10000);
      assert.match(await evaluate(ctx, viewText()), /King Louie now runs as King Louie Node/);
      assert.strictEqual(await evaluate(ctx, `document.getElementById('setup-action-nodeInstallPreview').classList.contains('btn-primary')`), true);
      await shot(ctx, '1b-fresh-install');
      await ctx.electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('desktop:nodeInstallPreview');
        ipcMain.handle('desktop:nodeInstallPreview', () => ({ ok: false, code: 'X', error: 'It said <b>no</b>.' }));
      });
      await evaluate(ctx, `document.getElementById('setup-action-nodeInstallPreview').click(); true`);
      await waitFor(ctx, `document.getElementById('setup-press-error').textContent.includes('It said <b>no</b>.')`, 10000);
      assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('#setup-press-error b').length`), 0);
      assert.strictEqual(await evaluate(ctx, `document.getElementById('setup-action-nodeInstallPreview').disabled`), false);
    });

    it('Install is shown in a <pre>, and passes the press', async () => {
      const answer = await showStatus(ctx, { node: { fresh: true }, installPreview: { ok: true, lines: ['Would register the logon task "KingLouie Node".', `Would write ${LONG_DIR}\\node.yaml`] } });
      await waitFor(ctx, shown('#setup-pre'), 10000);
      assert.match(await evaluate(ctx, `document.getElementById('setup-pre').textContent`), /Would register/);
      assert.strictEqual(await evaluate(ctx, shown('#setup-press-error')), false, 'the refused press was about the screen before');
      assert.deepStrictEqual(answer.actions.map((a) => a.id), ['nodeInstall']);
      assert.deepStrictEqual(await widthOverflow(ctx), []);
      await shot(ctx, '4-install-preview');
      await evaluate(ctx, `document.getElementById('setup-action-nodeInstall').click(); true`);
      await waitFor(ctx, `!document.getElementById('setup-action-nodeInstall').disabled`, 10000);
      assert.deepStrictEqual((await presses(ctx)).at(-1), { id: 'nodeInstall', payload: { confirmed: true } });
    });

    it('the settings link opens over the view and comes back to it', async () => {
      await showStatus(ctx, { node: null });
      await waitFor(ctx, shown('#setup-action-openServiceSettings'), 10000);
      await evaluate(ctx, `document.getElementById('setup-action-openServiceSettings').click(); true`);
      await waitFor(ctx, shown('#settings-drawer'), 10000);
      await shot(ctx, '5-settings-over-view');
      await evaluate(ctx, `document.getElementById('close-settings-btn').click(); true`);
      await waitFor(ctx, `!document.getElementById('settings-drawer').checkVisibility()`, 10000);
      assert.strictEqual(await evaluate(ctx, shown('#setup-view')), true);
    });

    it('the machine with a setup this app cannot take over says so, with a way to look', async () => {
      const answer = await showStatus(ctx, { node: null, bridge: { ok: true } });
      assert.deepStrictEqual(answer.actions.map((a) => a.id), ['openServiceSettings', 'retry']);
      await waitFor(ctx, `document.getElementById('setup-error').textContent.includes('cannot take over')`, 10000);
      await shot(ctx, '3b-not-personal');
    });

    it('with the node down the panes say SERVICE_UNREACHABLE, not "none"', async () => {
      const refusal = { ok: false, code: 'SERVICE_UNREACHABLE', error: 'The local King Louie service is not reachable (127.0.0.1:18796).' };
      await ctx.electronApp.evaluate(({ ipcMain }, answer) => {
        for (const channel of ['skill:listWithSettings', 'settings:load', 'webhook:list', 'apps:list', 'diagnostics:run']) {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, () => answer);
        }
      }, refusal);
      await evaluate(ctx, `Promise.all([loadSettings(), loadSkillSettingsTabs(), loadWebhookList(), loadSystemApps()]).then(() => true)`);
      for (const id of ['skills-status', 'hooks-status', 'webhook-list-status', 'apps-status']) {
        assert.match(await evaluate(ctx, `document.getElementById(${JSON.stringify(id)}).textContent`), /not reachable/, id);
      }
      assert.doesNotMatch(await evaluate(ctx, `document.getElementById('skills-list').textContent`), /No skills loaded/);
      await evaluate(ctx, `document.getElementById('diagnostics-run-btn').click(); true`);
      await waitFor(ctx, `document.getElementById('diagnostics-status').textContent.includes('not reachable')`, 5000);
    });

    it('a webhook\'s name from the node is text, and a refused delete is said', async () => {
      const hook = { id: 'w1', name: '<img src=x onerror="document.body.dataset.pwned=2">', url: 'http://127.0.0.1:1/<b>u</b>' };
      await ctx.electronApp.evaluate(({ ipcMain }, row) => {
        ipcMain.removeHandler('webhook:list');
        ipcMain.handle('webhook:list', () => ({ ok: true, data: [row] }));
        ipcMain.removeHandler('webhook:delete');
        ipcMain.handle('webhook:delete', () => ({ ok: false, code: 'SERVICE_UNREACHABLE', error: 'The local King Louie service is not reachable.' }));
      }, hook);
      await evaluate(ctx, `loadWebhookList().then(() => true)`);
      assert.strictEqual(await evaluate(ctx, `document.querySelectorAll('#webhook-list img, #webhook-list b').length`), 0);
      assert.strictEqual(await evaluate(ctx, `document.querySelector('#webhook-list strong').textContent`), hook.name);
      assert.strictEqual(await evaluate(ctx, `document.body.dataset.pwned || null`), null);
      await evaluate(ctx, `document.querySelector('#webhook-list button[data-action="delete-webhook"]').click(); true`);
      await waitFor(ctx, `document.getElementById('webhook-list-status').textContent.includes('not reachable')`, 5000);
    });

    it('the keyboard does not reach past the view', async () => {
      const page = await ctx.electronApp.firstWindow();
      await page.keyboard.press('Control+,');
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(await evaluate(ctx, shown('#settings-drawer')), false);
    });

    it('the provider step takes the wizard\'s form and saves through the node, and a typed key survives a repaint', async () => {
      await showStatus(ctx, connected({ service: { hosting: 'personal', providersConfigured: false } }));
      await waitFor(ctx, shown('#wizard-provider'), 10000);
      await evaluate(ctx, `document.getElementById('wizard-apikey').value = 'sk-example-not-a-key'; true`);
      await showStatus(ctx, connected({ service: { hosting: 'personal', providersConfigured: false } }));
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(await evaluate(ctx, `document.getElementById('wizard-apikey').value`), 'sk-example-not-a-key');
      assert.strictEqual(await evaluate(ctx, `document.querySelector('#wizard-provider option[value="ollama"]')`), null, 'no key for Ollama here');
      assert.match(await evaluate(ctx, viewText()), /To use Ollama/);
      assert.strictEqual(await evaluate(ctx, `document.activeElement.id`), 'wizard-provider', 'a new screen starts at its form');
      await shot(ctx, '6-provider');
      await evaluate(ctx, `document.getElementById('wizard-apikey').focus(); true`);
      await showStatus(ctx, connected({ service: { hosting: 'personal', providersConfigured: false } }));
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(await evaluate(ctx, `document.activeElement.id`), 'wizard-apikey', 'a repaint leaves the focus');
      const before = (await saves(ctx)).length;
      const page = await ctx.electronApp.firstWindow();
      await page.keyboard.press('Enter');
      await waitFor(ctx, `!document.getElementById('setup-action-formSave').disabled`, 10000);
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual((await saves(ctx)).length, before + 1, 'Enter submits the form');
      assert.deepStrictEqual((await saves(ctx)).at(-1), { channel: 'settings:saveProvider', keys: ['provider', 'token'] });
    });

    it('an empty form is said, and a refused save is said', async () => {
      await evaluate(ctx, `document.getElementById('wizard-apikey').value = ''; document.getElementById('setup-action-formSave').click(); true`);
      await waitFor(ctx, `document.getElementById('setup-press-error').textContent.length > 0`, 5000);
      await ctx.electronApp.evaluate(() => { globalThis.klStub.saveAnswer = { ok: false, code: 'SERVICE_UNREACHABLE', error: 'The local King Louie service is not reachable.' }; });
      await evaluate(ctx, `document.getElementById('wizard-apikey').value = 'sk-example-not-a-key'; document.getElementById('setup-action-formSave').click(); true`);
      await waitFor(ctx, `document.getElementById('setup-press-error').textContent.includes('not reachable')`, 5000);
      await ctx.electronApp.evaluate(() => { globalThis.klStub.saveAnswer = { ok: true }; });
    });

    it('the profile step takes the wizard\'s form, with the moved lines still on screen', async () => {
      await showStatus(ctx, connected({ userProfileDefault: true, migration: { at: '2026-11-04T10:00:00.000Z', backupDir: LONG_DIR, staysBehind: ['Voice settings and files'], private: { note: 'One private chat moved.' } } }));
      await waitFor(ctx, shown('#wizard-name'), 10000);
      const text = await evaluate(ctx, viewText());
      assert.match(text, /moved into King Louie Node/);
      assert.match(text, /One private chat moved/);
      assert.match(text, /Voice settings and files/);
      await shot(ctx, '7-profile');
      await evaluate(ctx, `document.getElementById('wizard-name').value = 'Example Owner'; document.getElementById('setup-action-formSave').click(); true`);
      await waitFor(ctx, `!document.getElementById('setup-action-formSave').disabled`, 10000);
      assert.deepStrictEqual((await saves(ctx)).at(-1), { channel: 'settings:saveUserProfile', keys: ['profile'] });
    });

    it('a restart that failed after the move has a press on the form steps', async () => {
      await showStatus(ctx, connected({ userProfileDefault: true, migration: { at: 'x', backupDir: 'C:\\b' }, setupError: { code: 'NODE_START_FAILED', error: 'King Louie Node did not restart after the move (no).', offerRestart: true } }));
      await waitFor(ctx, shown('#setup-action-nodeRestart'), 10000);
      assert.match(await evaluate(ctx, `document.getElementById('setup-error').textContent`), /did not restart/);
      assert.strictEqual(await evaluate(ctx, shown('#wizard-name')), true);
      await ctx.electronApp.evaluate(() => { globalThis.klStub.saveAnswer = { ok: false, code: 'X', error: 'The save was refused.' }; });
      await evaluate(ctx, `document.getElementById('wizard-name').value = 'Example Owner'; document.getElementById('setup-action-formSave').click(); true`);
      await waitFor(ctx, `document.getElementById('setup-press-error').textContent === 'The save was refused.' && document.getElementById('setup-press-error').checkVisibility()`, 5000);
      await ctx.electronApp.evaluate(() => { globalThis.klStub.saveAnswer = { ok: true }; });
      await shot(ctx, '8-restart-failed');
    });

    it('the phone step is text and Skip, and the press names its step', async () => {
      await showStatus(ctx, connected());
      await waitFor(ctx, shown('#setup-action-skip'), 10000);
      assert.strictEqual(await evaluate(ctx, shown('#wizard-name')), false);
      assert.match(await evaluate(ctx, `document.getElementById('setup-pre').textContent`), /enroll-device/);
      assert.deepStrictEqual(await widthOverflow(ctx), []);
      await shot(ctx, '9-phone');
      await evaluate(ctx, `document.getElementById('setup-action-skip').click(); true`);
      await waitFor(ctx, `!document.getElementById('setup-action-skip').disabled`, 10000);
      assert.deepStrictEqual((await presses(ctx)).at(-1), { id: 'setupFinish', payload: { skip: 'phone' } });
    });

    it('the done path: the screen with Open King Louie, then out of the view to the chat', async () => {
      const answer = await showStatus(ctx, connected({ setup: { phoneSeen: true } }));
      assert.strictEqual(answer.step, 'done');
      assert.deepStrictEqual(answer.actions.map((a) => a.id), ['setupFinish']);
      await waitFor(ctx, shown('#setup-action-setupFinish'), 10000);
      await shot(ctx, '10-done-screen');
      await evaluate(ctx, `document.getElementById('setup-action-setupFinish').click(); true`);
      await waitFor(ctx, `!document.getElementById('setup-action-setupFinish')?.disabled`, 10000);
      await showStatus(ctx, connected({ setup: { phoneSeen: true, completedAt: '2026-11-04T10:00:00.000Z' } }));
      await waitFor(ctx, `!document.getElementById('setup-view').checkVisibility()`, 10000);
      assert.strictEqual(await isVisible(ctx, '#user-input'), true);
      assert.strictEqual(await evaluate(ctx, shown('.sidebar')), true);
      assert.strictEqual(await evaluate(ctx, shown('#open-settings-btn')), true);
      await shot(ctx, '11-after-done');
    });

    it('a failed refresh gives each button its own state back', async () => {
      const shownBefore = await showStatus(ctx, { view: 'pairing', pendingPair: { request: 'r', deviceFingerprint: 'aa', command: 'king-louie-service desktop pair r', service: null }, node: { fresh: true } });
      assert.ok(shownBefore.actions.some((a) => a.id === 'pairConfirm' && a.disabled), JSON.stringify(shownBefore.actions));
      await waitFor(ctx, shown('#setup-action-pairConfirm'), 10000);
      await ctx.electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('desktop:status');
        ipcMain.handle('desktop:status', () => { throw new Error('no status'); });
      });
      await evaluate(ctx, `document.getElementById('setup-action-pairCancel').click(); true`);
      await waitFor(ctx, `!document.getElementById('setup-action-pairCancel').disabled`, 10000);
      assert.strictEqual(await evaluate(ctx, `document.getElementById('setup-action-pairConfirm').disabled`), true, 'Confirm stays off');
      await ctx.electronApp.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('desktop:status');
        ipcMain.handle('desktop:status', () => globalThis.klStub.status);
      });
    });

    it('a fleet pairing has no setup to show', async () => {
      const answer = await showStatus(ctx, connected({ pairing: { service: { hosting: 'service' } } }));
      assert.deepStrictEqual([answer.step, answer.lines, answer.actions], ['done', [], []]);
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(await evaluate(ctx, shown('#setup-view')), false);
    });
  });

  describe('--kl-standalone', () => {
    let ctx;
    before(async () => { ctx = await launchApp(); });
    after(async () => { await closeApp(ctx); });

    it('shows no setup', async () => {
      await waitFor(ctx, shown('.sidebar'), 10000);
      await new Promise((r) => setTimeout(r, 1000));
      assert.strictEqual(await evaluate(ctx, shown('#setup-view')), false);
      assert.strictEqual(await evaluate(ctx, `document.body.classList.contains('setup-active')`), false);
      assert.strictEqual(await evaluate(ctx, shown('.sidebar')), true);
      assert.strictEqual(await evaluate(ctx, `document.documentElement.classList.contains('setup-pending')`), false);
      assert.strictEqual(await evaluate(ctx, `location.search`), '', 'a standalone launch loads as it always has');
      await shot(ctx, '12-standalone-dev');
    });
  });

  describe('a chat with a task', () => {
    let ctx;
    before(async () => {
      ctx = await launchApp({ seed: { 'chat-data.json': { onboardingComplete: true, chats: [
        { id: 'task-chat', title: 'A task', taskId: 'task-1', client: 'claude.ai', createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', messages: [{ id: 'm1', sender: 'user', text: 'do it', timestamp: '2026-11-03T00:00:00.000Z' }] },
        { id: 'plain-chat', title: 'A chat', createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', messages: [{ id: 'm2', sender: 'user', text: 'hello', timestamp: '2026-11-02T00:00:00.000Z' }] }
      ] } } });
    });
    after(async () => { await closeApp(ctx); });

    it('wears the badge in the list and above its messages; another chat does not', async () => {
      await waitFor(ctx, `document.querySelector('.chat-item[data-chat-id="task-chat"] .chat-item-task-badge')?.textContent === 'Task · claude.ai'`, 15000);
      assert.strictEqual(await evaluate(ctx, `document.querySelector('.chat-item[data-chat-id="plain-chat"] .chat-item-task-badge')`), null);
      await evaluate(ctx, `document.querySelector('.chat-item[data-chat-id="task-chat"] .chat-view-btn').click(); true`);
      await waitFor(ctx, `document.getElementById('chat-header-task-badge').textContent === 'Task · claude.ai' && !document.getElementById('chat-header-task-badge').hidden`, 10000);
      await shot(ctx, '13-task-badge');
      await evaluate(ctx, `document.querySelector('.chat-item[data-chat-id="plain-chat"] .chat-view-btn').click(); true`);
      await waitFor(ctx, `document.getElementById('chat-header-task-badge').hidden`, 10000);
    });
  });
});
