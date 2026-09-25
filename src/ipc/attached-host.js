// Attached mode (fleet stage 7 §3.7): no core, no listener. Every IPC channel
// the handlers register is answered here: locally, by a native dialog then a
// bridge method, by the service over the bridge, or with "not available".
const { createLogger } = require('../logging');
const { listIpcChannels } = require('./channel-inventory');
const { createDesktopHandler } = require('./desktop-handlers');
const { createDesktopController } = require('./desktop-controller');
const { classifyChannel, isRendererEvent } = require('../desktop-bridge/allowlist');
const { MESSAGES, DEFAULT_DESKTOP_BRIDGE_PORT } = require('../desktop-bridge/protocol');

const log = createLogger('attached-host');

function startAttachedHost(deps) {
  const {
    app, ipcMain, safeStorage, dialog, getWindow, state,
    env = process.env, platform = process.platform,
    listChannels = listIpcChannels, clientFactory = null, controllerFactory = createDesktopController
  } = deps;
  const controller = controllerFactory({
    state, mode: 'attached', app, getWindow, env, platform,
    userDataDir: app.getPath('userData'), safeStorage, clientFactory
  });
  const client = controller.createClient();
  controller.setClient(client);
  const openRuns = new Map(); // responseId -> chatId

  const port = () => (client && client.port) || (state.pairing && state.pairing.service && state.pairing.service.port) || DEFAULT_DESKTOP_BRIDGE_PORT;
  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const unreachable = () => ({ ok: false, code: 'SERVICE_UNREACHABLE', error: MESSAGES.SERVICE_UNREACHABLE(port()) });
  const unavailable = () => ({ ok: false, code: 'ATTACHED_UNAVAILABLE', error: MESSAGES.ATTACHED_UNAVAILABLE });
  const errorResult = (err) => ({
    ok: false,
    code: err.code || 'SERVICE_UNREACHABLE',
    error: err.code === 'PAYLOAD_TOO_LARGE' ? MESSAGES.PAYLOAD_TOO_LARGE : err.message
  });
  const live = () => Boolean(client && client.connected);
  const served = (channel) => Boolean(client && client.service && Array.isArray(client.service.channels) && client.service.channels.includes(channel));

  async function providerReady() {
    if (!client.service || client.service.providersConfigured !== false) return true;
    try {
      client.service = await client.call('bridge.status');
    } catch { /* keep the old summary */ }
    return client.service.providersConfigured !== false;
  }

  async function proxyInvoke(channel, args) {
    if (!live()) return unreachable();
    if (!served(channel)) return { ok: false, code: 'SERVICE_TOO_OLD', error: MESSAGES.SERVICE_TOO_OLD(client.service.version, channel) };
    if (channel === 'chat:sendMessage' && !(await providerReady())) return { ok: false, code: 'NO_PROVIDER', error: MESSAGES.NO_PROVIDER };
    try {
      return await client.invoke(channel, args);
    } catch (err) {
      return errorResult(err);
    }
  }

  const LOCAL = {
    'wizard:getStatus': async () => ({ ok: true, isFirstRun: false }),
    'wizard:complete': async () => ({ ok: true }),
    'wizard:getSteps': async () => {
      const { getWizardSteps } = require('../wizard/onboarding-wizard');
      return { ok: true, steps: getWizardSteps().map((s) => ({ id: s.id, title: s.title, description: s.description, optional: s.optional })) };
    },
    'app:quitWindow': async () => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.close();
      return { ok: true };
    }
  };

  // Native dialog here, then the service checks the path as its own account.
  const PRESTEP = {
    'chat:pickWorkingDirectory': async (_event, { chatId } = {}) => {
      const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'], title: 'Select Working Directory' });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { ok: true, data: { canceled: true } };
      if (!live()) return unreachable();
      try {
        const value = await client.call('bridge.setWorkingDirectory', { chatId, path: result.filePaths[0] });
        return { ok: true, data: { canceled: false, chat: value && value.ok ? value.data : value } };
      } catch (err) {
        return errorResult(err);
      }
    },
    'settings:addAllowedDirectory': async () => {
      const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory'], title: 'Add Allowed Directory' });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { ok: false, canceled: true };
      if (!live()) return unreachable();
      try {
        return await client.call('bridge.addAllowedDirectory', { path: result.filePaths[0] });
      } catch (err) {
        return errorResult(err);
      }
    }
  };

  const inventory = listChannels();
  for (const channel of inventory.handle) {
    const route = classifyChannel(channel);
    let fn;
    if (route === 'local') fn = channel.startsWith('desktop:') ? createDesktopHandler(channel, () => controller) : (LOCAL[channel] || (async () => unavailable()));
    else if (route === 'prestep') fn = PRESTEP[channel];
    else if (route === 'proxy') fn = (_event, ...args) => proxyInvoke(channel, args);
    else fn = async () => unavailable();
    ipcMain.handle(channel, fn);
  }
  for (const channel of inventory.on) {
    const route = classifyChannel(channel);
    ipcMain.on(channel, (_event, ...args) => {
      if (route !== 'proxy' || !live() || !served(channel)) {
        log.debug(`dropped ${channel} while attached`);
        return;
      }
      client.send(channel, args);
    });
  }
  ipcMain.on('canvas:executeJsResult', (_event, payload = {}) => {
    if (live()) client.call('bridge.canvasJsResult', payload).catch(() => {});
  });

  if (client) {
    client.on('event', (channel, payload) => {
      if (!isRendererEvent(channel)) return;
      if (channel === 'chat:messageStart' && payload) openRuns.set(payload.responseId, payload.chatId);
      if ((channel === 'chat:messageComplete' || channel === 'chat:messageError') && payload) openRuns.delete(payload.responseId);
      send(channel, payload);
    });
    client.on('state', (s) => {
      if (s.status === 'connected' || openRuns.size === 0) return;
      for (const [responseId, chatId] of openRuns) send('chat:messageError', { chatId, responseId, error: MESSAGES.SERVICE_RESTARTED });
      openRuns.clear();
    });
  }

  return {
    controller,
    client,
    start() {
      if (client) client.connect().catch((err) => log.warn(`the local service is not reachable yet: ${err.message}`));
    },
    async shutdown() {
      controller.dispose();
      if (client) client.close();
    }
  };
}

module.exports = { startAttachedHost };
