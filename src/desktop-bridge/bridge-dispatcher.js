// The service side of attached mode (fleet stage 7 §3.4). It registers the
// very handler modules the desktop runs against a virtual ipcMain, serves the
// allowlisted subset, builds a fresh marked event per call, and binds every
// prompt it forwards to the connection that saw it.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { registerHandlers: defaultRegisterHandlers } = require('../ipc/register');
const { listIpcChannels } = require('../ipc/channel-inventory');
const { createElectronPrompter } = require('../platform/electron-prompter');
const { markLocalDesktopEvent } = require('../core/origin');
const { servedChannels, isRendererEvent, PROMPT_EVENTS } = require('./allowlist');
const { createDesktopScope } = require('./desktop-scope');
const { checkPath: defaultCheckPath } = require('./check-path');
const { MESSAGES } = require('./protocol');

const log = createLogger('desktop-bridge');

// Which inbound send answers which forwarded prompt, and where its id lives.
const PROMPT_RESPONSES = Object.freeze({
  'tool:approvalResponse': ['approvals', 'approvalId'],
  'tool:directoryAccessResponse': ['directory', 'requestId'],
  'agent:userResponse': ['askUser', 'requestId']
});

const fail = (code, message) => Object.assign(new Error(message), { code });

// Settings > Local service "Approvals and relay" (spec §3.9), read from F3's
// startApprovals objects; { available: false } until F3 has merged.
function approvalsStatus({ approvals, dataDir }) {
  if (!approvals || !approvals.approverStore || !approvals.phoneApprover) return { available: false };
  let link = null;
  try {
    link = JSON.parse(fs.readFileSync(path.join(dataDir, 'approvals', 'link.json'), 'utf8'));
  } catch {
    link = null;
  }
  const store = approvals.approverStore;
  const devices = (store.list() || []).map((r) => ({
    device_id: r.device_id,
    name: r.name || null,
    platform: r.platform || null,
    active: typeof store.isActive === 'function' ? Boolean(store.isActive(r.device_id)) : true
  }));
  const pending = typeof approvals.phoneApprover.pending === 'function' ? approvals.phoneApprover.pending() : [];
  const tail = approvals.auditLedger && typeof approvals.auditLedger.tail === 'function' ? approvals.auditLedger.tail(1) : [];
  const last = Array.isArray(tail) && tail.length ? tail[tail.length - 1] : null;
  return {
    available: true,
    relay: {
      configured: Boolean(link || approvals.relayClient),
      connected: Boolean(link && link.connected),
      since: (link && link.since) || null,
      relay_id: (link && link.relay_id) || null
    },
    devices,
    pending: pending.map((p) => ({ request_id: p.request_id, summary: p.summary, expires_at: p.expires_at })),
    audit: { last_seq: last ? last.seq : null, last_at: last ? last.at : null }
  };
}

function createBridgeDispatcher({
  core, cipher = null, dataDir, approvals = null, account = null,
  getServiceInfo = () => ({}), getConnection = () => null,
  registerHandlers = defaultRegisterHandlers, listChannels = listIpcChannels,
  checkPath = defaultCheckPath, createImporter = null
}) {
  const context = core.context;
  const handlers = new Map();
  const listeners = new Map();
  const virtualIpcMain = {
    handle: (channel, fn) => { handlers.set(channel, fn); },
    on: (channel, fn) => { listeners.set(channel, fn); },
    removeHandler: (channel) => { handlers.delete(channel); }
  };
  const pendingAskUserResolvers = new Map();
  const pendingDirectoryAccessResolvers = new Map();
  const scope = createDesktopScope({ dataDir, context });

  const pushEvent = (conn, channel, payload) => {
    if (!conn || !conn.live || !isRendererEvent(channel)) return;
    if (payload && channel === 'tool:approvalRequired') conn.prompts.approvals.add(payload.approvalId);
    if (payload && channel === 'agent:askUser') conn.prompts.askUser.add(payload.requestId);
    if (payload && channel === 'tool:directoryAccessRequired') conn.prompts.directory.add(payload.requestId);
    if (payload && channel === 'canvas:executeJs') conn.prompts.canvas.add(payload.requestId);
    conn.send({ t: 'event', channel, payload });
  };

  // What createElectronPrompter treats as the window: the live connection.
  const connectionAsWindow = () => {
    const conn = getConnection();
    if (!conn || !conn.live) return null;
    return { isDestroyed: () => !conn.live, webContents: { send: (channel, payload) => pushEvent(conn, channel, payload) } };
  };
  const inner = createElectronPrompter({ getWindow: connectionAsWindow, pendingAskUserResolvers, pendingDirectoryAccessResolvers });
  const prompter = {
    askUser(args) {
      const conn = getConnection();
      if (!conn || !conn.live) return inner.askUser(args);
      const before = new Set(pendingAskUserResolvers.keys());
      const answer = inner.askUser(args);
      const issued = [...pendingAskUserResolvers.keys()].filter((id) => !before.has(id));
      return Promise.race([answer, conn.gone.then(() => {
        for (const id of issued) pendingAskUserResolvers.delete(id);
        return { ok: false, error: 'The desktop disconnected.' };
      })]);
    },
    requestDirectoryAccess: (args) => inner.requestDirectoryAccess(args)
  };

  const bridgeContext = {
    ...context,
    getSettings: scope.getSettings,
    setSettings: scope.setSettings,
    addPermissionRule: scope.addPermissionRule,
    removePermissionRule: scope.removePermissionRule,
    safeStorage: { isEncryptionAvailable: () => Boolean(cipher && cipher.isEncryptionAvailable()) },
    getMainWindow: () => null,
    getShell: () => null,
    pendingAskUserResolvers,
    pendingDirectoryAccessResolvers,
    prompter
  };
  registerHandlers(virtualIpcMain, bridgeContext);

  const inventory = listChannels();
  const served = servedChannels({
    handle: inventory.handle.filter((ch) => handlers.has(ch)),
    on: inventory.on.filter((ch) => listeners.has(ch))
  });
  const servedHandle = new Set(served.handle);
  const servedOn = new Set(served.on);

  const makeEvent = (conn) => markLocalDesktopEvent(
    { sender: { send: (channel, payload) => pushEvent(conn, channel, payload), isDestroyed: () => !conn.live } },
    { deviceId: conn.deviceId }
  );

  async function onInvoke(conn, frame) {
    const { id, channel } = frame;
    if (!Number.isInteger(id)) return;
    const args = Array.isArray(frame.args) ? frame.args : [];
    if (typeof channel !== 'string' || !servedHandle.has(channel)) {
      conn.send({ t: 'result', id, error: MESSAGES.CHANNEL_NOT_PROXIED(String(channel)), code: 'CHANNEL_NOT_PROXIED' });
      return;
    }
    const chatId = channel === 'chat:sendMessage' && args[0] && typeof args[0].chatId === 'string' ? args[0].chatId : null;
    if (chatId) conn.runs.add(chatId);
    try {
      const value = await handlers.get(channel)(makeEvent(conn), ...args);
      conn.send({ t: 'result', id, value: value === undefined ? null : value });
    } catch (err) {
      conn.send({ t: 'result', id, error: (err && err.message) || String(err), code: (err && err.code) || 'HANDLER_ERROR' });
    } finally {
      if (chatId) conn.runs.delete(chatId);
    }
  }

  function onSend(conn, frame) {
    const { channel } = frame;
    const args = Array.isArray(frame.args) ? frame.args : [];
    if (typeof channel !== 'string' || !servedOn.has(channel)) {
      log.warn(`dropped a send on ${channel}: not served over the bridge`);
      return;
    }
    const binding = PROMPT_RESPONSES[channel];
    if (binding) {
      const [kind, key] = binding;
      const id = args[0] && args[0][key];
      if (!conn.prompts[kind].has(id)) {
        log.warn(`dropped ${channel} for a prompt this connection was not shown`);
        return;
      }
      conn.prompts[kind].delete(id);
    }
    try {
      listeners.get(channel)(makeEvent(conn), ...args);
    } catch (err) {
      log.warn(`${channel} failed: ${err.message}`);
    }
  }

  function resolveCanvas(conn, { requestId, result, error } = {}) {
    const pending = core.pendingCanvasJsResolvers && core.pendingCanvasJsResolvers.get(requestId);
    if (!pending || !conn.prompts.canvas.has(requestId)) return { ok: false, error: 'No canvas request is waiting for that result.' };
    conn.prompts.canvas.delete(requestId);
    core.pendingCanvasJsResolvers.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve(error ? { action: 'execute_js', error } : { action: 'execute_js', result });
    return { ok: true };
  }

  let importer = null;
  async function getImporter() {
    if (!importer) {
      if (!createImporter) throw fail('IMPORT_UNAVAILABLE', 'This service cannot import from a desktop.');
      importer = await createImporter({ scope, checkPath });
    }
    return importer;
  }

  async function readableDirectory(target) {
    const check = await checkPath(target);
    if (!check.readable || !check.isDirectory) throw fail('PATH_NOT_ACCESSIBLE', MESSAGES.PATH_NOT_ACCESSIBLE(account, target));
  }

  async function callMethod(conn, method, params) {
    switch (method) {
      case 'bridge.status':
        return getServiceInfo();
      case 'bridge.checkPath':
        return checkPath(params.path);
      case 'bridge.setWorkingDirectory':
        await readableDirectory(params.path);
        return handlers.get('chat:setWorkingDirectory')(makeEvent(conn), { chatId: params.chatId, workingDirectory: params.path });
      case 'bridge.addAllowedDirectory':
        await readableDirectory(params.path);
        return { ok: true, allowedDirectories: scope.addDirectory(params.path) };
      case 'bridge.canvasJsResult':
        return resolveCanvas(conn, params);
      case 'bridge.approvalsStatus':
        return approvalsStatus({ approvals, dataDir });
      case 'import.plan':
        return (await getImporter()).plan({ ...params, source: 'bridge', connectionId: conn.id });
      case 'import.apply':
        return (await getImporter()).apply(params);
      case 'import.finish':
        return (await getImporter()).finish(params);
      default:
        throw fail('UNKNOWN_METHOD', `Unknown bridge method ${method}.`);
    }
  }

  async function onCall(conn, frame) {
    const { id, method } = frame;
    if (!Number.isInteger(id)) return;
    const params = frame.params && typeof frame.params === 'object' ? frame.params : {};
    try {
      const value = await callMethod(conn, method, params);
      conn.send({ t: 'result', id, value: value === undefined ? null : value });
    } catch (err) {
      conn.send({ t: 'result', id, error: (err && err.message) || String(err), code: (err && err.code) || 'CALL_FAILED' });
    }
  }

  async function handleFrame(conn, frame) {
    if (frame.t === 'invoke') return onInvoke(conn, frame);
    if (frame.t === 'send') return onSend(conn, frame);
    if (frame.t === 'call') return onCall(conn, frame);
    log.warn(`dropped an unknown frame type ${frame.t}`);
    return undefined;
  }

  // Nothing started from a desktop keeps running unattended (spec §3.3).
  async function onDisconnect(conn) {
    if (conn.cleaned) return;
    conn.cleaned = true;
    conn.markGone();
    if (importer) importer.expireConnection(conn.id);
    const event = makeEvent(conn);
    const approvalResponse = listeners.get('tool:approvalResponse');
    for (const approvalId of [...conn.prompts.approvals]) {
      try { if (approvalResponse) approvalResponse(event, { approvalId, approved: false }); } catch (err) { log.warn(`denying a prompt failed: ${err.message}`); }
    }
    const directoryResponse = listeners.get('tool:directoryAccessResponse');
    for (const requestId of [...conn.prompts.directory]) {
      try { if (directoryResponse) directoryResponse(event, { requestId, approved: false }); } catch (err) { log.warn(`denying a prompt failed: ${err.message}`); }
    }
    // A pending canvas:executeJs is bound to this connection and nothing else
    // will ever answer it; reject it now instead of leaving it to its own
    // 10 s execution timeout (create-core.js), which would otherwise be the
    // only thing standing between it and a permanently pending promise if
    // that timeout is ever removed or lengthened.
    for (const requestId of [...conn.prompts.canvas]) {
      const pending = core.pendingCanvasJsResolvers && core.pendingCanvasJsResolvers.get(requestId);
      if (!pending) continue;
      core.pendingCanvasJsResolvers.delete(requestId);
      clearTimeout(pending.timeout);
      try { pending.reject(new Error('The desktop disconnected.')); } catch (err) { log.warn(`rejecting a canvas request failed: ${err.message}`); }
    }
    conn.prompts.approvals.clear();
    conn.prompts.directory.clear();
    conn.prompts.askUser.clear();
    conn.prompts.canvas.clear();
    const stop = handlers.get('chat:stopResponse');
    for (const chatId of [...conn.runs]) {
      try {
        if (stop) await stop(event, { chatId });
        context.appendMessageToChat(chatId, 'assistant', MESSAGES.DESKTOP_DISCONNECTED_RUN);
        log.info(`stopped chat ${chatId}: its desktop disconnected`);
      } catch (err) {
        log.warn(`stopping chat ${chatId} failed: ${err.message}`);
      }
    }
    conn.runs.clear();
  }

  // The core's own ui.send (chat:updated, backgroundTask:completed, case:*):
  // never a prompt, so a remote-origin run cannot borrow the dialog.
  function forwardAmbient(channel, payload) {
    const conn = getConnection();
    if (!conn || !conn.live || !isRendererEvent(channel) || PROMPT_EVENTS.has(channel)) return;
    conn.send({ t: 'event', channel, payload });
  }

  function providersConfigured() {
    try {
      const tokens = context.getApiTokens() || {};
      return Object.entries(tokens).some(([name, value]) => !name.startsWith('__') && Boolean(value));
    } catch {
      return false;
    }
  }

  return { served, providersConfigured, handleFrame, onDisconnect, forwardAmbient, bridgeContext, scope };
}

module.exports = { createBridgeDispatcher, approvalsStatus };
