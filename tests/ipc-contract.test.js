const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { registerHandlers } = require('../src/ipc/register');
const IPC = require('../src/ipc/constants');

/**
 * Static contract test: every channel the renderer can invoke through the
 * preload bridge MUST have a registered main-process handler. A missing
 * handler means `ipcRenderer.invoke(...)` rejects with "No handler registered
 * for '<channel>'", silently breaking that UI flow.
 *
 * We capture the real handler set by running the actual registration code
 * against a fake ipcMain (no Electron required), and the invoked set by
 * parsing preload.js.
 */
describe('IPC contract: preload invoke ↔ main handler', () => {
  const registered = new Set();
  const registeredOn = new Set();
  let invoked;

  before(() => {
    const fakeIpcMain = {
      handle: (channel) => registered.add(channel),
      on: (channel) => registeredOn.add(channel)
    };
    // Proxy context: any accessed property is a harmless no-op function so
    // registration (which only reads context, rarely calls it) never throws.
    const ctx = new Proxy({}, { get: () => (() => {}) });
    registerHandlers(fakeIpcMain, ctx);

    const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
    const resolve = (raw) => {
      raw = raw.trim();
      const lit = raw.match(/^["'`]([^"'`]+)["'`]$/);
      if (lit) return lit[1];
      const c = raw.match(/\.([A-Z0-9_]+)$/);
      if (c && IPC[c[1]]) return IPC[c[1]];
      return null;
    };
    invoked = new Set();
    for (const m of preload.matchAll(/ipcRenderer\.invoke\(\s*([^,)]+)/g)) {
      const ch = resolve(m[1]);
      if (ch) invoked.add(ch);
    }
  });

  it('captures a non-trivial number of channels (sanity)', () => {
    assert.ok(registered.size > 50, `expected >50 handlers, got ${registered.size}`);
    assert.ok(invoked.size > 50, `expected >50 invoked channels, got ${invoked.size}`);
  });

  it('every invoked channel has a registered handler', () => {
    const missing = [...invoked].filter((ch) => !registered.has(ch)).sort();
    assert.deepStrictEqual(
      missing,
      [],
      `Renderer invokes channels with NO main handler (these reject at runtime):\n  ${missing.join('\n  ')}`
    );
  });
});
