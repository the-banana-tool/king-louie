const { describe, it } = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const preloadPath = path.join(__dirname, '..', 'preload.js');
const preloadCode = fs.readFileSync(preloadPath, 'utf8');

/**
 * Run preload.js in a VM with a configurable `require`, capturing the
 * contextBridge.exposeInMainWorld(name, api) call.
 *
 * @param {(module: string) => any} requireImpl
 */
function runPreload(requireImpl) {
  let exposedName = null;
  let exposedApi = null;
  const sandbox = {
    require: (mod) => {
      if (mod === 'electron') {
        return {
          contextBridge: {
            exposeInMainWorld: (name, api) => { exposedName = name; exposedApi = api; }
          },
          ipcRenderer: { invoke: async () => ({ ok: true }), on: () => {}, send: () => {}, removeListener: () => {} }
        };
      }
      return requireImpl(mod);
    },
    console,
    Date,
    process: { env: {} }
  };
  vm.runInContext(preloadCode, vm.createContext(sandbox));
  return { exposedName, exposedApi };
}

describe('preload → window.electron bridge resilience', () => {
  it('exposes window.electron under normal requires', () => {
    const { exposedName, exposedApi } = runPreload((mod) => require(mod));
    assert.strictEqual(exposedName, 'electron');
    assert.ok(exposedApi && exposedApi.settings, 'settings namespace must be exposed');
    assert.ok(exposedApi.chat, 'chat namespace must be exposed');
  });

  it('STILL exposes window.electron when the bundled logging module cannot be required', () => {
    // Reproduces the whole-UI outage: a sandboxed preload where relative
    // requires throw. Before the fix this aborted the preload, leaving
    // window.electron undefined and every IPC call failing with
    // "Cannot read properties of undefined (reading 'settings')".
    const { exposedName, exposedApi } = runPreload((mod) => {
      if (mod === './src/logging') throw new Error('sandbox: relative require blocked');
      // Optional deps already degrade gracefully; mimic them being blocked too.
      throw new Error('sandbox: module require blocked');
    });
    assert.strictEqual(exposedName, 'electron', 'bridge must be exposed even if requires fail');
    assert.ok(exposedApi && exposedApi.settings && typeof exposedApi.settings.load === 'function');
  });
});

describe('BrowserWindow webPreferences (preload contract)', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  // Grab the webPreferences object literal.
  const m = mainSrc.match(/webPreferences:\s*\{([\s\S]*?)\}/);

  it('declares a webPreferences block', () => {
    assert.ok(m, 'could not find webPreferences in main.js');
  });

  it('disables the renderer sandbox so the preload can require bundled Node modules', () => {
    // With Electron 20+ defaulting sandbox to true, omitting this re-breaks the
    // preload (and thus the whole UI). The renderer is still isolated via
    // contextIsolation + nodeIntegration:false.
    assert.match(m[1], /sandbox:\s*false/, 'webPreferences must set sandbox: false');
    assert.match(m[1], /contextIsolation:\s*true/);
    assert.match(m[1], /nodeIntegration:\s*false/);
  });
});
