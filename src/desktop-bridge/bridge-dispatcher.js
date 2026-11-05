// The service side of attached mode (fleet stage 7 §3.4). It registers the
// very handler modules the desktop runs against a virtual ipcMain, serves the
// allowlisted subset, builds a fresh marked event per call, and binds every
// prompt it forwards to the connection that saw it. Every other renderer event
// goes to every window (remote window plan R-RW-7). A remote connection's frames
// take one more path (R-RW-11, R-RW-12): served, then the class of the channel or
// method, then the class its payload raises it to; a phone-class call runs only
// on a signed approval of its exact arguments.
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../logging');
const { registerHandlers: defaultRegisterHandlers } = require('../ipc/register');
const { listIpcChannels } = require('../ipc/channel-inventory');
const { createElectronPrompter } = require('../platform/electron-prompter');
const { markLocalDesktopEvent, markRemoteWindowEvent } = require('../core/origin');
const { canonicalize } = require('../platform/jcs');
const { WINDOW_TOOL } = require('../approvals/messages');
const { plainLineProblem } = require('../cases/hidden-chars');
const { llmCommandAction, LLM_CHANNEL_ACTIONS } = require('../core/llm-command');
const { servedChannels, isRendererEvent, PROMPT_EVENTS } = require('./allowlist');
const { createDesktopScope } = require('./desktop-scope');
const { checkPath: defaultCheckPath } = require('./check-path');
const { MESSAGES } = require('./protocol');
const { runFor, currentConnection, runInChat, currentChatId } = require('./run-context');
const { PRESS_CHANNELS_REMOTE, remotePayloadClass } = require('./remote-classes');
const { windowCard } = require('./window-cards');

const log = createLogger('desktop-bridge');

// What goes to one window, the run's, and never to the others.
const ONE_WINDOW_EVENTS = new Set([...PROMPT_EVENTS, 'canvas:executeJs']);
// What the window that acted has already drawn: for every window but that one.
const OTHER_WINDOWS_EVENTS = new Set(['chat:rowAdded', 'chat:listChanged']);

// Which inbound send answers which forwarded prompt, and where its id lives.
const PROMPT_RESPONSES = Object.freeze({
  'tool:approvalResponse': ['approvals', 'approvalId'],
  'tool:directoryAccessResponse': ['directory', 'requestId'],
  'agent:userResponse': ['askUser', 'requestId']
});

const fail = (code, message) => Object.assign(new Error(message), { code });

const WINDOW_SUMMARY_MAX = 120;
// What a stolen laptop can have waiting on the phone at once (R-RW-32): enough that a
// mis-tap is not the way out of a flood, and each ask is one more mirrored ledger entry.
const PHONE_ASKS_PER_DEVICE = 8;

const remoteRefusal = (code, error = MESSAGES[code]) => ({ ok: false, code, error });

// The card's one line. A label is the window's own words, so one that is not one
// plain line is not shown; the channel name comes from the class table.
const windowName = (label) => (plainLineProblem(label) === null ? label : 'a window (name hidden)');
function windowSummary(name, label) {
  return Array.from(`${name} from ${windowName(label)}`).slice(0, WINDOW_SUMMARY_MAX).join('');
}

// Settings > Local service "Approvals and relay" (spec §3.9), read from F3's
// startApprovals objects; { available: false } when there are none.
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
  core, cipher = null, dataDir, approvals = null, account = null, hosting = 'service',
  getServiceInfo = () => ({}), getConnection = () => null, getConnections = () => [],
  registerHandlers = defaultRegisterHandlers, listChannels = listIpcChannels,
  checkPath = defaultCheckPath, createImporter = null, approvalGate = null
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
  // deviceId -> [{ chatId, payload }]: questions waiting for that device to come back.
  const pendingAskUserByDevice = new Map();
  // requestId -> { chatId, payload }, for every remote question not yet ended.
  const remoteAsks = new Map();
  // deviceId -> how many of its asks the phone has not answered.
  const phoneAsks = new Map();
  const takePhoneSlot = (deviceId) => {
    const held = phoneAsks.get(deviceId) || 0;
    if (held >= PHONE_ASKS_PER_DEVICE) return false;
    phoneAsks.set(deviceId, held + 1);
    return true;
  };
  const freePhoneSlot = (deviceId) => {
    const held = phoneAsks.get(deviceId) - 1;
    if (held > 0) phoneAsks.set(deviceId, held);
    else phoneAsks.delete(deviceId);
  };

  const anyWindowLive = () => getConnections().some((c) => c.live);

  // One window's failure to take a frame is not the run's, nor the next window's.
  const broadcast = (channel, payload, except = null) => {
    for (const conn of getConnections()) {
      if (!conn.live || conn === except) continue;
      try {
        conn.send({ t: 'event', channel, payload });
      } catch (err) {
        log.warn(`sending ${channel} to a window failed: ${err.message}`);
      }
    }
  };

  // A pending canvas:executeJs is bound to one connection and nothing else will
  // ever answer it.
  const failCanvas = (requestId) => {
    const pending = core.pendingCanvasJsResolvers && core.pendingCanvasJsResolvers.get(requestId);
    if (!pending) return;
    core.pendingCanvasJsResolvers.delete(requestId);
    clearTimeout(pending.timeout);
    try { pending.reject(new Error('The desktop disconnected.')); } catch (err) { log.warn(`rejecting a canvas request failed: ${err.message}`); }
  };

  // A prompt no window will see is refused now, or its caller waits out its timeout
  // and its resolver stays behind. agent:askUser never gets here: the prompter checks
  // the connection in the same tick it sends, and answers for itself.
  const refusePrompt = (conn, channel, payload) => {
    if (!payload) return;
    if (channel === 'canvas:executeJs') {
      // sender.isDestroyed() stays false while another window is live, so
      // create-core's own check no longer catches a gone window's code.
      failCanvas(payload.requestId);
      return;
    }
    const answer = channel === 'tool:approvalRequired'
      ? ['tool:approvalResponse', { approvalId: payload.approvalId, approved: false }]
      : channel === 'tool:directoryAccessRequired'
        ? ['tool:directoryAccessResponse', { requestId: payload.requestId, approved: false }]
        : null;
    if (!answer) return;
    try {
      listeners.get(answer[0])?.(conn ? makeEvent(conn) : {}, answer[1]);
    } catch (err) {
      log.warn(`refusing a prompt failed: ${err.message}`);
    }
  };

  const pushEvent = (conn, channel, payload) => {
    if (!isRendererEvent(channel, { hosting })) return;
    if (!ONE_WINDOW_EVENTS.has(channel)) {
      broadcast(channel, payload, OTHER_WINDOWS_EVENTS.has(channel) ? conn : null);
      return;
    }
    // A dialog is only ever a local window's (spec §9).
    if (!conn || !conn.live || (channel === 'tool:approvalRequired' && conn.remote)) {
      refusePrompt(conn, channel, payload);
      return;
    }
    if (payload && channel === 'tool:approvalRequired') conn.prompts.approvals.add(payload.approvalId);
    if (payload && channel === 'agent:askUser') conn.prompts.askUser.add(payload.requestId);
    if (payload && channel === 'tool:directoryAccessRequired') conn.prompts.directory.add(payload.requestId);
    if (payload && channel === 'canvas:executeJs') conn.prompts.canvas.add(payload.requestId);
    conn.send({ t: 'event', channel, payload });
  };

  // What createElectronPrompter treats as the window: the run's connection.
  const connectionAsWindow = () => {
    const conn = getConnection();
    if (!conn || !conn.live) return null;
    return { isDestroyed: () => !conn.live, webContents: { send: (channel, payload) => pushEvent(conn, channel, payload) } };
  };
  const inner = createElectronPrompter({ getWindow: connectionAsWindow, pendingAskUserResolvers, pendingDirectoryAccessResolvers });

  const liveRemote = (deviceId) => getConnections().find((c) => c.live && c.remote && c.deviceId === deviceId) || null;
  const queueAsk = (deviceId, row) => {
    const rows = pendingAskUserByDevice.get(deviceId) || [];
    if (!rows.some((r) => r.payload.requestId === row.payload.requestId)) rows.push(row);
    pendingAskUserByDevice.set(deviceId, rows);
  };
  const forgetAsk = (deviceId, requestId) => {
    remoteAsks.delete(requestId);
    const rows = (pendingAskUserByDevice.get(deviceId) || []).filter((r) => r.payload.requestId !== requestId);
    if (rows.length > 0) pendingAskUserByDevice.set(deviceId, rows);
    else pendingAskUserByDevice.delete(deviceId);
  };

  // A remote run's question goes to its device, wherever that is now: typed words are
  // the owner's, and a question is not a gate (R-RW-7). Its resolver and 5-minute timer
  // are the prompter's own, so a window that never returns times out as ever (R-RW-8).
  const askRemote = (conn, args) => {
    const { deviceId } = conn;
    const chatId = currentChatId();
    let requestId = null;
    const device = {
      isDestroyed: () => false,
      webContents: {
        send: (channel, payload) => {
          requestId = payload.requestId;
          const row = { chatId, payload };
          remoteAsks.set(requestId, row);
          const live = liveRemote(deviceId);
          if (live) pushEvent(live, channel, payload);
          else queueAsk(deviceId, row);
          // The chat is held by a question the other windows cannot see.
          broadcast('chat:questionWaiting', { chatId, label: windowName(conn.label) }, live);
        }
      }
    };
    const answer = createElectronPrompter({ getWindow: () => device, pendingAskUserResolvers, pendingDirectoryAccessResolvers }).askUser(args);
    return answer.finally(() => forgetAsk(deviceId, requestId));
  };

  // What a device missed while it was away. Safe to call again: a row goes out once.
  function replayPrompts(conn) {
    if (!conn.remote || !conn.live) return;
    const rows = pendingAskUserByDevice.get(conn.deviceId);
    if (!rows) return;
    pendingAskUserByDevice.delete(conn.deviceId);
    for (const row of rows) pushEvent(conn, 'agent:askUser', row.payload);
  }

  const windowOrigin = (conn) => ({ client: 'remote-window', deviceId: conn.deviceId, session: null, job_id: null });

  // A folder for a remote run is the phone's to allow: a remote window never sees the
  // dialog (R-RW-7). No phone, no folder.
  async function allowDirectoryOnPhone(conn, { directory, toolName, signal = null }) {
    const approver = approvals && approvals.phoneApprover;
    if (!approver || !takePhoneSlot(conn.deviceId)) return false;
    try {
      // The signal withdraws the card when the run is stopped.
      const either = signal ? AbortSignal.any([signal, conn.revokeSignal]) : conn.revokeSignal;
      const answer = await approver.requestApproval('AllowDirectory', { directory, toolName }, { origin: windowOrigin(conn), cardNote: `From ${windowName(conn.label)}`, signal: either });
      return answer === true && !conn.revoked;
    } catch (err) {
      log.warn(`asking the phone for a folder failed: ${err.message}`);
      return false;
    } finally {
      freePhoneSlot(conn.deviceId);
    }
  }

  const prompter = {
    askUser(args) {
      const conn = getConnection();
      if (conn && conn.remote) return askRemote(conn, args);
      if (!conn || !conn.live) return inner.askUser(args);
      const before = new Set(pendingAskUserResolvers.keys());
      const answer = inner.askUser(args);
      const issued = [...pendingAskUserResolvers.keys()].filter((id) => !before.has(id));
      return Promise.race([answer, conn.gone.then(() => {
        for (const id of issued) pendingAskUserResolvers.delete(id);
        return { ok: false, error: 'The desktop disconnected.' };
      })]);
    },
    requestDirectoryAccess(args) {
      const conn = getConnection();
      if (conn && conn.remote) return allowDirectoryOnPhone(conn, args);
      return inner.requestDirectoryAccess(args);
    }
  };

  // settings:runLlmCommand is proxied, but its channel actions are not
  // (spec §8: channels are not proxied): refused here, before the core
  // sees them, so the desktop can neither start a channel in the service
  // nor store a channel token there. A personal node takes them (spec
  // 2026-11-03 G-2): the desktop has no core, so no bot answers twice.
  const runLlmCommand = async (command) => {
    if (hosting !== 'personal' && LLM_CHANNEL_ACTIONS.includes(llmCommandAction(command))) {
      return { ok: false, code: 'CHANNELS_NOT_PROXIED', error: MESSAGES.CHANNELS_NOT_PROXIED };
    }
    return context.runLlmCommand(command);
  };

  // Each device has its own open chat, or one window's selection would move another's
  // next send (a private or case chat included). The first read pins it from the stored
  // selection, which only a local window writes: what a new device starts from and what
  // a restart comes back to. Outside a frame there is no device, and the store answers.
  const openChats = new Map(); // deviceId -> chatId
  const getActiveChatId = () => {
    const conn = currentConnection();
    if (!conn) return context.getActiveChatId();
    if (!openChats.has(conn.deviceId)) openChats.set(conn.deviceId, context.getActiveChatId());
    return openChats.get(conn.deviceId);
  };
  const setActiveChatId = (chatId) => {
    const conn = currentConnection();
    if (conn) openChats.set(conn.deviceId, chatId);
    if (!conn || !conn.remote) context.setActiveChatId(chatId);
  };

  const bridgeContext = {
    ...context,
    getActiveChatId,
    setActiveChatId,
    // This copy is made when the bridge opens, before the fleet starts and sets this on
    // core.context, and it outlasts the fleet's stop: so it asks the core's on every call.
    isTaskChatRunning: (chatId) => context.isTaskChatRunning?.(chatId) === true,
    runLlmCommand,
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
  }, { hosting });
  const servedHandle = new Set(served.handle);
  const servedOn = new Set(served.on);

  // History stage H4 (owner ruling R-H4-3): a chat a desktop parsed arrives
  // in batches. The import each connection has open is remembered, so one
  // left unfinished is removed when that connection goes, not 30 minutes
  // later (the gate's idle timer) or at the next start (the sweep).
  const openImports = new WeakMap(); // conn -> importId
  const noteImport = (conn, channel, value) => {
    if (channel === 'history:import.begin' && value && value.ok === true && typeof value.importId === 'string') {
      openImports.set(conn, value.importId);
    } else if (channel === 'history:import.finish' && value && value.ok === true) {
      openImports.delete(conn);
    }
  };
  const dropImport = (conn) => {
    const importId = openImports.get(conn);
    if (!importId) return;
    openImports.delete(conn);
    try {
      const gate = typeof context.getHistoryImportGate === 'function' ? context.getHistoryImportGate() : null;
      if (gate && typeof gate.abort === 'function') gate.abort({ importId, reason: 'its desktop disconnected' });
    } catch (err) {
      log.warn(`removing an unfinished import failed: ${err.message}`);
    }
  };

  // A run outlives its window's connection for a while, and the others are still
  // watching its chat: the sender is gone only when no window is left. A prompt
  // for a gone connection still goes nowhere (pushEvent).
  const makeEvent = (conn, approved = null) => {
    const event = { sender: { send: (channel, payload) => pushEvent(conn, channel, payload), isDestroyed: () => !conn.live && !anyWindowLive() } };
    return conn.remote
      ? markRemoteWindowEvent(event, { deviceId: conn.deviceId, approved })
      : markLocalDesktopEvent(event, { deviceId: conn.deviceId });
  };

  // One signed approval over the exact arguments (R-RW-12). The arguments are read
  // once, here: the card is built from the text, and what runs is parsed from that text
  // after the answer, so nothing that holds the frame or the approver's copy can change
  // what runs. → { ok: true, request_id, args } | a refusal.
  async function gatePhoneClass(conn, name, args) {
    const approver = approvals && approvals.phoneApprover;
    if (!approver || typeof approver.requestApproval !== 'function') return remoteRefusal('NO_PHONE');
    let text;
    try {
      text = canonicalize(args);
    } catch {
      return remoteRefusal('REMOTE_ARGS_INVALID');
    }
    const card = windowCard(name, JSON.parse(text), text);
    if (card.refusal) return remoteRefusal(card.refusal);
    // Part C's seam (R-RW-21), asked before the phone; nothing passes one yet.
    const granted = approvalGate ? await approvalGate({ toolName: WINDOW_TOOL, params: card.params, metadata: { origin: windowOrigin(conn) } }) : null;
    if (granted && granted.allow === true && typeof granted.grant_id === 'string' && granted.grant_id) {
      return { ok: true, request_id: granted.grant_id, args: JSON.parse(text) };
    }
    if (!takePhoneSlot(conn.deviceId)) return remoteRefusal('PHONE_BUSY');
    const metadata = { origin: windowOrigin(conn), cardNote: windowSummary(name, conn.label), signal: conn.revokeSignal };
    let answer;
    try {
      answer = await approver.requestApproval(WINDOW_TOOL, card.params, metadata);
    } catch (err) {
      log.warn(`asking the phone about ${name} failed: ${err.message}`);
      return remoteRefusal('NO_PHONE');
    } finally {
      freePhoneSlot(conn.deviceId);
    }
    // A revoke takes back what the phone said, however the answer raced it (R-RW-31).
    if (conn.revoked) return remoteRefusal('PHONE_DENIED');
    if (answer === 'unavailable') return remoteRefusal('NO_PHONE', (metadata.refusal && metadata.refusal.error) || MESSAGES.NO_PHONE);
    // Only the exact true approves, and an approval has a request id to carry.
    if (answer !== true || typeof metadata.request_id !== 'string' || !metadata.request_id) return remoteRefusal('PHONE_DENIED');
    return { ok: true, request_id: metadata.request_id, args: JSON.parse(text) };
  }

  // What a remote frame may do, after the served check. → { refusal } | { approved, args },
  // `args` being what the handler gets. A name with no class is refused like a local one.
  async function remoteGate(conn, name, args) {
    const cls = remotePayloadClass(name, args, context);
    if (cls === 'read' || cls === 'ordinary') return { approved: null, args };
    if (cls !== 'phone') return { refusal: remoteRefusal(PRESS_CHANNELS_REMOTE.includes(name) ? 'REMOTE_PRESS' : 'REMOTE_LOCAL_ONLY') };
    // Refused by the handler's own check whatever the phone said, so nobody is asked.
    if (name === 'settings:runLlmCommand' && hosting !== 'personal') {
      const first = Array.isArray(args) ? args[0] : args;
      if (LLM_CHANNEL_ACTIONS.includes(llmCommandAction(first && first.command))) return { refusal: remoteRefusal('CHANNELS_NOT_PROXIED') };
    }
    const gate = await gatePhoneClass(conn, name, args);
    if (!gate.ok) return { refusal: gate };
    return { approved: gate.request_id, args: gate.args };
  }

  async function onInvoke(conn, frame) {
    const { id, channel } = frame;
    if (!Number.isInteger(id)) return;
    const frameArgs = Array.isArray(frame.args) ? frame.args : [];
    if (typeof channel !== 'string' || !servedHandle.has(channel)) {
      conn.send({ t: 'result', id, error: MESSAGES.CHANNEL_NOT_PROXIED(String(channel)), code: 'CHANNEL_NOT_PROXIED' });
      return;
    }
    let approved = null;
    let args = frameArgs;
    if (conn.remote) {
      const gate = await remoteGate(conn, channel, frameArgs);
      if (gate.refusal) {
        conn.send({ t: 'result', id, value: gate.refusal });
        return;
      }
      ({ approved, args } = gate);
    }
    // Only chat:sendMessage starts a run bound to this connection. No case:*
    // channel does: a case turn runs inside chat:sendMessage, and
    // case:answerQuestion only schedules an unattended wake-up, which must
    // outlive the desktop.
    // A refused send registers no run, so a drop finds nothing to stop for it.
    const chatId = channel === 'chat:sendMessage' && args[0] && typeof args[0].chatId === 'string' ? args[0].chatId : null;
    const event = makeEvent(conn, approved);
    if (chatId) conn.runs.set(event, chatId);
    try {
      const value = await runInChat(chatId, () => handlers.get(channel)(event, ...args));
      noteImport(conn, channel, value);
      // Begun for a desktop that left while the handler ran.
      if (!conn.live) dropImport(conn);
      conn.send({ t: 'result', id, value: value === undefined ? null : value });
    } catch (err) {
      conn.send({ t: 'result', id, error: (err && err.message) || String(err), code: (err && err.code) || 'HANDLER_ERROR' });
    } finally {
      if (chatId) conn.runs.delete(event);
    }
  }

  function onSend(conn, frame) {
    const { channel } = frame;
    const args = Array.isArray(frame.args) ? frame.args : [];
    if (typeof channel !== 'string' || !servedOn.has(channel)) {
      log.warn(`dropped a send on ${channel}: not served over the bridge`);
      return;
    }
    // An on-screen answer is never a remote window's, whoever's prompt it names.
    if (conn.remote && !['read', 'ordinary'].includes(remotePayloadClass(channel, args, context))) {
      log.warn(`dropped ${channel} from a remote window`);
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

  // The one DesktopImporter for this dispatcher's lifetime (Task 8 carry: a
  // second instance's cleanupOrphanedStaging would wipe the first one's live
  // staging directories). The PROMISE — not its resolved value — is memoized
  // before any await, so two import.plan/import.apply calls that land while
  // construction is still in flight share the one in-flight construction
  // instead of each starting their own createImporter(). Reset on rejection
  // so a failed construction can be retried by a later call. `importer`
  // (the resolved instance) stays a plain variable so onDisconnect's
  // best-effort expireConnection can check it without awaiting.
  let importerPromise = null;
  let importer = null;
  async function getImporter() {
    if (!createImporter) throw fail('IMPORT_UNAVAILABLE', 'This service cannot import from a desktop.');
    importerPromise ||= createImporter({ scope, checkPath })
      .then((instance) => { importer = instance; return instance; })
      .catch((err) => {
        importerPromise = null;
        throw err;
      });
    return importerPromise;
  }

  async function readableDirectory(target) {
    const check = await checkPath(target);
    if (!check.readable || !check.isDirectory) throw fail('PATH_NOT_ACCESSIBLE', MESSAGES.PATH_NOT_ACCESSIBLE(account, target));
  }

  async function callMethod(conn, method, params, approved = null) {
    switch (method) {
      case 'bridge.status':
        return getServiceInfo();
      case 'bridge.checkPath':
        return checkPath(params.path);
      case 'bridge.setWorkingDirectory':
        await readableDirectory(params.path);
        return handlers.get('chat:setWorkingDirectory')(makeEvent(conn, approved), { chatId: params.chatId, workingDirectory: params.path });
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
    const frameParams = frame.params && typeof frame.params === 'object' ? frame.params : {};
    let approved = null;
    let params = frameParams;
    if (conn.remote) {
      const gate = await remoteGate(conn, method, frameParams);
      if (gate.refusal) {
        conn.send({ t: 'result', id, value: gate.refusal });
        return;
      }
      approved = gate.approved;
      params = gate.args;
    }
    try {
      const value = await callMethod(conn, method, params, approved);
      conn.send({ t: 'result', id, value: value === undefined ? null : value });
    } catch (err) {
      conn.send({ t: 'result', id, error: (err && err.message) || String(err), code: (err && err.code) || 'CALL_FAILED' });
    }
  }

  async function handleFrame(conn, frame) {
    // Nothing a revoked device sent runs, whenever it got here (R-RW-31).
    if (conn.revoked) return undefined;
    return runFor(conn, () => {
      // A device back after a drop: whatever opens the conversation brings its questions.
      if (conn.remote) replayPrompts(conn);
      if (frame.t === 'invoke') return onInvoke(conn, frame);
      if (frame.t === 'send') return onSend(conn, frame);
      if (frame.t === 'call') return onCall(conn, frame);
      log.warn(`dropped an unknown frame type ${frame.t}`);
      return undefined;
    });
  }

  // A socket that drops on the road stops nothing (R-RW-8): its runs go on, and the
  // same device's next connection is told about them. It holds no dialog to deny.
  function onRemoteDisconnect(conn) {
    for (const requestId of [...conn.prompts.canvas]) failCanvas(requestId);
    conn.prompts.canvas.clear();
    for (const requestId of conn.prompts.askUser) {
      const row = remoteAsks.get(requestId);
      if (row) queueAsk(conn.deviceId, row);
    }
    conn.prompts.askUser.clear();
    // Its replacement may already be up (one connection per device).
    const live = liveRemote(conn.deviceId);
    if (live) replayPrompts(live);
  }

  // Nothing started from a local desktop keeps running unattended (spec §3.3).
  async function onDisconnect(conn) {
    if (conn.cleaned) return;
    conn.cleaned = true;
    conn.markGone();
    if (importer) importer.expireConnection(conn.id);
    dropImport(conn);
    if (conn.remote) {
      onRemoteDisconnect(conn);
      return;
    }
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
    for (const requestId of [...conn.prompts.canvas]) failCanvas(requestId);
    conn.prompts.approvals.clear();
    conn.prompts.directory.clear();
    conn.prompts.askUser.clear();
    conn.prompts.canvas.clear();
    // By run, not by chat: a run someone already stopped may still be unwinding here
    // while a newer run of the chat, another window's, goes on.
    for (const [runEvent, chatId] of [...conn.runs]) {
      try {
        if (bridgeContext.stopRunForEvent?.(runEvent) !== true) continue;
        context.appendMessageToChat(chatId, 'assistant', MESSAGES.DESKTOP_DISCONNECTED_RUN, {}, { returnChat: false });
        broadcast('chat:updated', { chatId });
        log.info(`stopped chat ${chatId}: its desktop disconnected`);
      } catch (err) {
        log.warn(`stopping chat ${chatId} failed: ${err.message}`);
      }
    }
    conn.runs.clear();
  }

  // A revoked device, where a drop stops nothing (R-RW-31): its runs stop, which withdraws
  // the tool cards they hold. The cards of its calls go by conn.revokeSignal, and
  // the server calls this for a connection already gone as well.
  function onRevoke(conn) {
    for (const [runEvent, chatId] of [...conn.runs]) {
      try {
        if (bridgeContext.stopRunForEvent?.(runEvent) !== true) continue;
        context.appendMessageToChat(chatId, 'assistant', MESSAGES.WINDOW_REVOKED_RUN, {}, { returnChat: false });
        broadcast('chat:updated', { chatId });
        log.info(`stopped chat ${chatId}: its window was revoked`);
      } catch (err) {
        log.warn(`stopping chat ${chatId} failed: ${err.message}`);
      }
    }
  }

  // The core's own ui.send (chat:updated, backgroundTask:completed, case:changed):
  // never a prompt, so a remote-origin run cannot borrow the dialog.
  function forwardAmbient(channel, payload) {
    if (!isRendererEvent(channel, { hosting }) || ONE_WINDOW_EVENTS.has(channel)) return;
    broadcast(channel, payload);
  }

  function providersConfigured() {
    try {
      const tokens = context.getApiTokens() || {};
      return Object.entries(tokens).some(([name, value]) => !name.startsWith('__') && Boolean(value));
    } catch {
      return false;
    }
  }

  return {
    served, providersConfigured, handleFrame, onDisconnect, onRevoke, forwardAmbient, bridgeContext, scope,
    gatePhoneClass, replayPrompts, pendingAskUserByDevice
  };
}

module.exports = { createBridgeDispatcher, approvalsStatus };
