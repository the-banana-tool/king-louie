'use strict';
// Settings redesign spec §8.3 ("Switch to my node" follows the launch rule) and
// §8.2 (Open data folder): the controller's leaveStandalone and openDataFolder.

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonFileStore } = require('../src/platform/json-file-store');
const { openDesktopState } = require('../src/ipc/desktop-state');
const { createDesktopController } = require('../src/ipc/desktop-controller');
const { DESKTOP_METHODS } = require('../src/ipc/desktop-handlers');
const IPC = require('../src/ipc/constants');

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-leave-')); dirs.push(d); return d; };
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${s}`),
  decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^sealed:/, '')
};
const storeFactory = ({ name, cwd, defaults }) => new JsonFileStore({ dir: cwd, name, defaults });

function make({ why = 'once', pairing = null, openPath } = {}) {
  const userDataDir = tmp();
  const state = openDesktopState(userDataDir, safeStorage, { storeFactory });
  if (pairing) state.setPairing(pairing);
  const calls = [];
  const app = { relaunch: (o) => calls.push(['relaunch', o]), exit: (c) => calls.push(['exit', c]), quit: () => calls.push(['quit']), getPath: () => userDataDir };
  const controller = createDesktopController({
    state, mode: 'standalone', app, env: {}, platform: 'win32', userDataDir, safeStorage,
    stdout: { write() {} }, argv: ['electron', '.', '--kl-standalone-once'], username: 'alex',
    nodeRunner: null, readBridgeFile: () => ({ ok: false }),
    launch: { host: 'standalone', why, degraded: why === 'once' },
    ...(openPath ? { openPath } : {})
  });
  return { controller, state, calls };
}

const record = (service) => ({ deviceId: 'kld-abcdefghijklmnop', publicKey: 'x', privateKeySealed: 'y', label: 'desk', service });
const fleetService = { nodeId: 'kln-1', publicKey: 'ab', port: 18796, pairedAt: '2026-11-01T00:00:00Z' };
const personalService = { ...fleetService, hosting: 'personal', dataDir: 'C:\\Users\\alex\\AppData\\Local\\KingLouie\\node\\data' };

describe('desktop controller: leaveStandalone', () => {
  it('refuses unless this launch is standalone-once', async () => {
    const { controller, calls, state } = make({ why: 'dev', pairing: record(fleetService) });
    const r = await controller.leaveStandalone();
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_ONCE');
    assert.deepEqual(calls, []);
    assert.notEqual(state.mode, 'attached');
    controller.dispose();
  });

  it('with a pairing it attaches: mode attached, relaunched without the flag', async () => {
    const { controller, calls, state } = make({ pairing: record(fleetService) });
    const r = await controller.leaveStandalone();
    assert.equal(r.ok, true);
    assert.equal(state.mode, 'attached');
    const relaunch = calls.find(([c]) => c === 'relaunch');
    assert.ok(relaunch, 'relaunched');
    assert.ok(!relaunch[1].args.includes('--kl-standalone-once'));
    controller.dispose();
  });

  it('with no pairing it relaunches and leaves the mode to the launch rule', async () => {
    const { controller, calls, state } = make();
    const before = state.mode;
    const r = await controller.leaveStandalone();
    assert.equal(r.ok, true);
    assert.equal(state.mode, before);
    assert.notEqual(state.mode, 'attached');
    const relaunch = calls.find(([c]) => c === 'relaunch');
    assert.ok(relaunch, 'relaunched');
    assert.ok(!relaunch[1].args.includes('--kl-standalone-once'));
    controller.dispose();
  });
});

describe('desktop controller: openDataFolder', () => {
  it('refuses NOT_PERSONAL without a personal pairing', async () => {
    const opened = [];
    for (const pairing of [null, record(fleetService)]) {
      const { controller } = make({ pairing, openPath: async (p) => { opened.push(p); return ''; } });
      const r = await controller.openDataFolder();
      assert.equal(r.ok, false);
      assert.equal(r.code, 'NOT_PERSONAL');
      controller.dispose();
    }
    assert.deepEqual(opened, []);
  });

  it('opens the personal node\'s data dir through the injected shell', async () => {
    const opened = [];
    const { controller } = make({ pairing: record(personalService), openPath: async (p) => { opened.push(p); return ''; } });
    assert.deepEqual(await controller.openDataFolder(), { ok: true });
    assert.deepEqual(opened, [personalService.dataDir]);
    controller.dispose();
  });

  it('reports the shell\'s failure', async () => {
    const { controller } = make({ pairing: record(personalService), openPath: async () => 'Failed to open path' });
    const r = await controller.openDataFolder();
    assert.equal(r.ok, false);
    assert.equal(r.code, 'OPEN_FAILED');
    controller.dispose();
  });
});

describe('desktop channels', () => {
  it('constants and handler methods', () => {
    assert.equal(IPC.DESKTOP_LEAVE_STANDALONE, 'desktop:leaveStandalone');
    assert.equal(IPC.DESKTOP_OPEN_DATA_FOLDER, 'desktop:openDataFolder');
    assert.equal(DESKTOP_METHODS['desktop:leaveStandalone'], 'leaveStandalone');
    assert.equal(DESKTOP_METHODS['desktop:openDataFolder'], 'openDataFolder');
  });

  it('preload exposes both', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    assert.match(src, /leaveStandalone: \(\) => ipcRenderer\.invoke\('desktop:leaveStandalone'\)/);
    assert.match(src, /openDataFolder: \(\) => ipcRenderer\.invoke\('desktop:openDataFolder'\)/);
  });
});
