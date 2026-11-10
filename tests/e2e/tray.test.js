// tests/e2e/tray.test.js
// King Louie in the tray (boot-node-tray spec §5.4, C-8, C-10). Windows only.
//
// The profile is seeded attached to a personal node pairing whose port nothing
// listens on and whose data dir is an empty temp folder: no node, no service
// and no screen-host file, so the app stays "not reachable" and the screen host
// waits. The native tray cannot be clicked by Playwright, so its actions go
// through the main process's KL_TEST_MODE hook (`globalThis.__klTestTray` in
// main.js); the window's state is read from BrowserWindow itself.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { launchApp, closeApp } = require('./helpers');
const { deriveNodeId } = require('../../src/mesh/node-identity');

const skip = process.platform !== 'win32' ? 'tray mode is the Windows personal node' : false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function personalSeed() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kl-e2e-tray-node-'));
  const port = await freePort();
  // The client checks its pin at construction: a node key and the id it derives.
  const publicKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
  const nodeId = deriveNodeId(publicKey);
  return {
    dataDir,
    seed: {
      'chat-data.json': { onboardingComplete: true },
      'desktop-bridge.json': {
        mode: 'attached',
        installId: 'e2e-tray',
        setup: { completedAt: '2026-11-09T00:00:00Z' },
        pairing: {
          deviceId: 'e2e-tray-device',
          publicKey: 'AAAA',
          privateKeySealed: 'AAAA',
          label: 'e2e',
          service: { nodeId, publicKey, port, hosting: 'personal', dataDir, name: 'Example' }
        }
      }
    }
  };
}

async function launchPersonal(dataDir, seed, args) {
  try {
    const ctx = await launchApp({ attached: true, seed, ...(args ? { args } : {}) });
    ctx.extraDirs.push(dataDir);
    return ctx;
  } catch (err) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }
}

const windowVisible =(ctx) => ctx.electronApp.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0];
  return Boolean(win && !win.isDestroyed() && win.isVisible());
});
const windowCount = (ctx) => ctx.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const trayExists = (ctx) => ctx.electronApp.evaluate(() => Boolean(globalThis.__klTestTray && globalThis.__klTestTray.exists()));
const trayInvoke = (ctx, id) => ctx.electronApp.evaluate((_e, item) => globalThis.__klTestTray.invoke(item), id);

// closeApp asks Playwright for the process, which throws once the app has
// quit by itself; after the tray's Quit only the temp dirs are left.
async function removeDirs(ctx) {
  ctx.closed = true;
  for (const dir of [ctx.ownsDir ? ctx.userDataDir : null, ...ctx.extraDirs].filter(Boolean)) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch (err) {
        if (attempt === 9) throw err;
        await delay(300);
      }
    }
  }
}

async function until(fn, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await delay(200);
  }
  throw new Error('timed out');
}

describe('E2E: the tray', { skip }, () => {
  it('starts with no visible window; the tray action opens it; closing hides it; tray Quit exits', async () => {
    const { dataDir, seed } = await personalSeed();
    const ctx = await launchPersonal(dataDir, seed, ['--kl-tray']);
    try {
      await until(() => trayExists(ctx));
      assert.strictEqual(await windowVisible(ctx), false, 'hidden at start');

      const model = await ctx.electronApp.evaluate(() => globalThis.__klTestTray.model());
      assert.deepStrictEqual(model.items[0], { id: 'open', label: 'Open King Louie', enabled: true });
      assert.strictEqual(model.items[model.items.length - 1].id, 'quit');
      assert.notStrictEqual(model.icon, 'up', 'no node answers, so not running');

      assert.deepStrictEqual(await trayInvoke(ctx, 'open'), { ok: true });
      await until(() => windowVisible(ctx));

      await ctx.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
      await until(async () => !(await windowVisible(ctx)));
      assert.strictEqual(await windowCount(ctx), 1, 'hidden, not destroyed');
      assert.strictEqual(await trayExists(ctx), true);
      assert.strictEqual(ctx.exited, false);

      // The tray opens it again after a close.
      await trayInvoke(ctx, 'open');
      await until(() => windowVisible(ctx));

      // No take is recording, so Quit does not ask. The process goes, so do not await the call.
      await ctx.electronApp.evaluate(() => { setTimeout(() => { globalThis.__klTestTray.invoke('quit'); }, 0); });
      await until(() => ctx.exited, 30000);
    } finally {
      if (ctx.exited) await removeDirs(ctx);
      else await closeApp(ctx);
    }
  });

  it('without --kl-tray the window shows at start, and the tray is still there', async () => {
    const { dataDir, seed } = await personalSeed();
    const ctx = await launchPersonal(dataDir, seed);
    try {
      await until(() => trayExists(ctx));
      assert.strictEqual(await windowVisible(ctx), true);
    } finally {
      await closeApp(ctx);
    }
  });

  it('--kl-tray on a standalone launch shows the window and makes no tray', async () => {
    const ctx = await launchApp({ args: ['--kl-tray'] });
    try {
      assert.strictEqual(await windowVisible(ctx), true);
      await delay(1000);
      assert.strictEqual(await trayExists(ctx), false);
    } finally {
      await closeApp(ctx);
    }
  });
});
